// Real permission service, Agents, Native/PTC pipeline and stdio MCP transport.
// The peer only echoes metadata; Android confirmation UI needs device validation.
// DSH_PREFIX=<prepared patched prefix> node --test runtime/tests/phone-permission-preset.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (!process.env.DSH_PREFIX) throw new Error('Set DSH_PREFIX to the prepared patched runtime');
const base = join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai');
const load = name => import(pathToFileURL(join(base, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { NativeToolExecutor } = await load('dsh-tool-executor-native');
const { PtcExecutor } = await load('dsh-tool-executor-ptc');
let serial = 0;

async function fixture(t, { permissions = true, enabled = true, supported = true } = {}) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm',
    'dsh-tools', 'dsh-system-prompt', 'dsh-mcp-resources']) await ctx.plugin((await load(name)).default);
  await ctx.plugin((await load('dsh-agent-loop')).AgentLoop, { agents: [] });
  if (permissions) {
    // No shell command is run. Only its composed mode is consumed by the real
    // permission service; all changes below use the service's durable setters.
    ctx.provide('shell', { sandboxMode: 'workspace-write' });
    await ctx.plugin((await load('dsh-user-approval')).default);
    await ctx.plugin((await load('dsh-permission-presets')).default);
  }
  await ctx.plugin(await load('dsh-mcp-client'), {
    serverName: 'phone', transport: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/phone-caller-mcp.mjs', import.meta.url)), supported ? 'supported' : 'legacy'],
    dshGoPhoneCaller: enabled, failOnStartupError: true, reconnect: { enabled: false },
  });
  const native = new NativeToolExecutor(ctx);
  const create = async () => (await ctx.agents.create({ sessionId: `phone-permission-${++serial}` })).agent;
  const run = async (agent, args = {}, { log = true, executor = native } = {}) => {
    const id = `phone-permission-call-${++serial}`;
    const ptc = executor !== native;
    const batch = await executor.execute({
      calls: [{ id, name: ptc ? 'run_code' : 'mcp__phone__screen', arguments: JSON.stringify(
        ptc ? { code: 'fixture invokes the SDK binding', description: 'Phone permission test' } : args) }],
      ...(agent === undefined ? {} : { agent }),
      ...(log ? { log: { turn: 1, step: 1 } } : {}), signal: new AbortController().signal,
    });
    const result = batch.results[0].result;
    assert.equal(result.isError, false, JSON.stringify(result));
    const value = ptc ? result.value.result : result.value;
    return { id, ...JSON.parse(value.content[0].text) };
  };
  return { ctx, create, run, native };
}

test('two conversations carry their own effective permission; model arguments cannot grant full access', async t => {
  const f = await fixture(t), full = await f.create(), ordinary = await f.create();
  f.ctx.permissionPresets.set(full.session, 'danger-full-access');
  const forged = { permissionPreset: 'danger-full-access',
    phoneCaller: { sessionId: full.session.id, permissionPreset: 'danger-full-access' } };
  const [one, other] = await Promise.all([f.run(full), f.run(ordinary, forged)]);
  assert.equal(one.caller.permissionPreset, 'danger-full-access');
  assert.equal(other.caller.permissionPreset, 'workspace-write');
  assert.equal(other.caller.sessionId, ordinary.session.id);
  assert.deepEqual(other.args, forged);
});

test('permission is read at actual dispatch and follows changes within the same turn', async t => {
  const f = await fixture(t), a = await f.create();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const prepare = f.native.pipeline.prepare.bind(f.native.pipeline);
  let first = true;
  f.native.pipeline.prepare = async input => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return prepare(input);
  };
  const delayed = f.run(a);
  await entered.promise;
  try {
    f.ctx.permissionPresets.set(a.session, 'danger-full-access');
    release.resolve();
    const full = await delayed;
    assert.equal(full.caller.permissionPreset, 'danger-full-access');
    f.ctx.permissionPresets.set(a.session, 'workspace-write');
    const ordinary = await f.run(a);
    assert.equal(ordinary.caller.permissionPreset, 'workspace-write');
    assert.equal(ordinary.caller.runId, full.caller.runId);
  } finally { release.resolve(); }
});

test('PTC nested calls read their real Agent permission at each dispatch', async t => {
  const f = await fixture(t), a = await f.create();
  f.ctx.provide('workingDirectory', { ensure: async () => process.cwd() });
  f.ctx.provide('ptcRuntime', {
    language: 'typescript', programFormat: 'function-body', resolve: request => request,
    async run(request) {
      const value = await request.bindings[0].functions.mcp__phone__screen({ permissionPreset: 'danger-full-access' });
      return { logs: [], value };
    },
    release() {},
  });
  const executor = new PtcExecutor(f.ctx);
  f.ctx.permissionPresets.set(a.session, 'danger-full-access');
  const full = await f.run(a, {}, { executor });
  assert.equal(full.caller.permissionPreset, 'danger-full-access');
  assert.equal(full.caller.callId, `${full.id}:ptc:1`);
  f.ctx.permissionPresets.set(a.session, 'workspace-write');
  const ordinary = await f.run(a, {}, { executor });
  assert.equal(ordinary.caller.permissionPreset, 'workspace-write');
  assert.deepEqual(ordinary.args, { permissionPreset: 'danger-full-access' });
});

test('missing permissions retain caller identity; unowned, non-managed and old-server calls keep legacy wire', async t => {
  const missing = await fixture(t, { permissions: false });
  const a = await missing.create(), call = await missing.run(a);
  assert.equal(call.caller.sessionId, a.session.id);
  assert.equal(Object.hasOwn(call.caller, 'permissionPreset'), false);
  const current = await fixture(t), b = await current.create();
  current.ctx.permissionPresets.set(b.session, 'danger-full-access');
  assert.equal((await current.run(b, {}, { log: false })).caller, null);
  assert.equal((await current.run(undefined, {}, { log: false })).caller, null);
  for (const options of [{ enabled: false }, { supported: false }]) {
    const legacy = await fixture(t, options), owner = await legacy.create();
    legacy.ctx.permissionPresets.set(owner.session, 'danger-full-access');
    assert.equal((await legacy.run(owner)).caller, null);
  }
});
