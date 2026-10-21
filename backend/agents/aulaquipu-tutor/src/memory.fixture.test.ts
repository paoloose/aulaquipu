// Integración por HTTP real (fetch y el SDK de AtomicMemory) contra un FIXTURE LOCAL (127.0.0.1).
// El fixture NO es AtomicMemory Cloud: no extrae ni reconcilia hechos, solo guarda lo que recibe.
// Imita las rutas que se usan y las reglas documentadas que importan aquí:
// - un `thread` (session_id) reemplaza al sujeto `user` en Cloud v1
//   (https://docs.atomicstrata.ai/sdk/concepts/scopes-and-identity);
// - POST /v1/memories/ingest exige user_id, conversation y source_site, rechaza metadata con 400 y,
//   con RAW_CONTENT_POLICY=reject, rechaza content_class 'raw' o ausente con 422
//   (https://docs.atomicstrata.ai/api-reference/http/ingest-memory).
// Sin red externa.
import { MemoryClient } from '@atomicmemory/sdk/browser';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'clave-del-fixture';

type Stored = { id: string; subject: string; content: string };

const CONTENT_CLASSES = new Set(['summary', 'redacted', 'raw']);

function startFixture() {
  const memories: Stored[] = [];
  let nextId = 1;
  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let text = '';
    for await (const chunk of req) text += String(chunk);
    const parsed: unknown = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === 'object' ? Object.fromEntries(Object.entries(parsed)) : {};
  };
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`)
      return send(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://fixture');
    if (req.method === 'POST' && url.pathname === '/v1/memories/ingest') {
      const body = await readJson(req);
      if (!str(body.user_id)) return send(res, 400, { error: 'user_id (string) is required' });
      if (!str(body.conversation))
        return send(res, 400, { error: 'conversation (string) is required' });
      if (!str(body.source_site))
        return send(res, 400, { error: 'source_site (string) is required' });
      if ('metadata' in body)
        return send(res, 400, { error: 'metadata is only supported on /ingest/quick' });
      if (body.content_class !== undefined && !CONTENT_CLASSES.has(String(body.content_class))) {
        return send(res, 400, { error: 'content_class must be one of summary, redacted, raw' });
      }
      // RAW_CONTENT_POLICY=reject: sin clase cuenta como raw
      if (body.content_class === undefined || body.content_class === 'raw') {
        return send(res, 422, { error: 'raw_content_rejected' });
      }
      const subject = str(body.session_id) ?? str(body.user_id) ?? '';
      const content = str(body.conversation) ?? '';
      const id = `mem-${nextId++}`;
      memories.push({ id, subject, content });
      return send(res, 200, { stored_memory_ids: [id], updated_memory_ids: [] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/memories/search/fast') {
      const body = await readJson(req);
      const subject = str(body.session_id) ?? str(body.user_id);
      const limit = typeof body.limit === 'number' ? body.limit : 10;
      const found = memories.filter((m) => m.subject === subject).slice(0, limit);
      return send(res, 200, {
        memories: found.map((m) => ({
          id: m.id,
          content: m.content,
          user_id: m.subject,
          score: 1,
        })),
      });
    }
    const del = /^\/v1\/memories\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'DELETE' && del) {
      const index = memories.findIndex(
        (m) => m.id === del[1] && m.subject === url.searchParams.get('user_id'),
      );
      if (index < 0) return send(res, 404, { error: 'Memory not found' });
      memories.splice(index, 1);
      return send(res, 200, { success: true });
    }
    return send(res, 404, { error: 'not found' });
  });
  return { server, memories };
}

const fixture = startFixture();

async function load() {
  vi.resetModules();
  return import('./memory.ts');
}

describe('memoria de clases contra un fixture HTTP local (no es AtomicMemory Cloud)', () => {
  it('el fixture rechaza el ingest en modo text del SDK 1.1.1, que no envía content_class', async () => {
    const sdk = new MemoryClient({
      providers: { atomicmemory: { apiUrl: process.env.ATOMICMEMORY_API_URL ?? '', apiKey: KEY } },
    });
    await sdk.initialize();
    await expect(
      sdk.ingest({ mode: 'text', content: 'Ana domina rectas', scope: { user: 'alumno-ana' } }),
    ).rejects.toThrow(/HTTP 422/);
    expect(fixture.memories).toHaveLength(0);
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
    const address = fixture.server.address();
    if (!address || typeof address === 'string') throw new Error('el fixture no abrió un puerto');
    process.env.ATOMICMEMORY_API_URL = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    delete process.env.ATOMICMEMORY_API_URL;
    delete process.env.ATOMICMEMORY_API_KEY;
    await new Promise((resolve) => fixture.server.close(resolve));
  });
  beforeEach(() => {
    fixture.memories.length = 0;
    process.env.ATOMICMEMORY_API_KEY = KEY;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('lo guardado en una clase lo recuerda la siguiente clase del mismo alumno', async () => {
    const m = await load();
    const firstClass = m.memoryScope('alumno-ana', 'clase-1');
    expect(await m.remember(firstClass, 'Ana confunde el denominador al sumar fracciones')).toBe(
      true,
    );
    expect(fixture.memories).toEqual([
      {
        id: 'mem-1',
        subject: 'alumno-ana',
        content: 'Ana confunde el denominador al sumar fracciones',
      },
    ]);

    const nextClass = m.memoryScope('alumno-ana', 'clase-2');
    expect(await m.recallBrief(nextClass, 'progreso en fracciones')).toBe(
      '- Ana confunde el denominador al sumar fracciones',
    );
  });

  it('otro alumno no ve ni puede borrar lo de Ana', async () => {
    const m = await load();
    await m.remember(m.memoryScope('alumno-ana', 'clase-1'), 'Ana domina rectas');
    const luis = m.memoryScope('alumno-luis', 'clase-3');
    expect(await m.recallBrief(luis, 'progreso')).toBe('');
    expect(await m.forget(luis, 'Ana domina rectas')).toEqual({ kind: 'not_found' });
    expect(fixture.memories).toHaveLength(1);
  });

  it('el alumno pide olvidar un registro: se borra y la próxima clase ya no lo trae', async () => {
    const m = await load();
    await m.remember(
      m.memoryScope('alumno-ana', 'clase-1'),
      'Ana se pone nerviosa con los exámenes',
    );
    await m.remember(m.memoryScope('alumno-ana', 'clase-1'), 'Ana domina rectas');

    const now = m.memoryScope('alumno-ana', 'clase-2');
    await m.recallBrief(now, 'progreso');
    expect(await m.forget(now, 'se pone nerviosa con los exámenes')).toEqual({
      kind: 'forgotten',
      content: 'Ana se pone nerviosa con los exámenes',
    });
    expect(await m.recallBrief(m.memoryScope('alumno-ana', 'clase-3'), 'progreso')).toBe(
      '- Ana domina rectas',
    );
  });

  it('con una clave que el servicio rechaza, no dice que guardó y la clase sigue', async () => {
    process.env.ATOMICMEMORY_API_KEY = 'clave-equivocada';
    const m = await load();
    const scope = m.memoryScope('alumno-ana', 'clase-1');
    expect(await m.remember(scope, 'Ana domina rectas')).toBe(false);
    expect(await m.recallBrief(scope, 'progreso')).toBe('');
    expect(fixture.memories).toHaveLength(0);
  });

  it.runIf(process.env.RECORD_MEMORY_DEMO === '1')(
    'recorded real memory workflow across classes (HTTP local fixture)',
    async () => {
      const m = await load();
      const first = m.memoryScope('alumna-demo', 'primera-clase');
      const next = m.memoryScope('alumna-demo', 'siguiente-clase');
      const other = m.memoryScope('otro-alumno', 'clase-ajena');
      const pause = () => new Promise((resolve) => setTimeout(resolve, 1800));
      console.log(
        'AulaQuipu · adaptador real de memoria\nServidor HTTP local de prueba. Sin voz, LiveKit Cloud ni datos reales de alumnos.\n',
      );
      console.log(
        'PRIMERA CLASE > guardar resumen sintético: Domina rectas; quiere practicar fracciones.',
      );
      expect(await m.remember(first, 'Domina rectas; quiere practicar fracciones.')).toBe(true);
      console.log('API > guardado confirmado.');
      await pause();
      console.log('SIGUIENTE CLASE > recuperar progreso de la misma alumna');
      const recalled = await m.recallBrief(next, 'progreso');
      expect(recalled).toBe('- Domina rectas; quiere practicar fracciones.');
      console.log(`API > ${recalled}`);
      await pause();
      console.log('OTRO ALUMNO > recuperar progreso');
      expect(await m.recallBrief(other, 'progreso')).toBe('');
      console.log('API > sin recuerdos de la otra alumna.');
      await pause();
      console.log('ALUMNA > olvidar el resumen que acabamos de recuperar');
      const forgotten = await m.forget(next, 'Domina rectas; quiere practicar fracciones.');
      expect(forgotten.kind).toBe('forgotten');
      console.log(`API > ${forgotten.kind}`);
      await pause();
      console.log('NUEVA CLASE > recuperar progreso después de borrar');
      expect(await m.recallBrief(m.memoryScope('alumna-demo', 'tercera-clase'), 'progreso')).toBe(
        '',
      );
      console.log(
        'API > sin registros.\nVerificado: continuidad entre clases, aislamiento y borrado confirmado.',
      );
      await pause();
    },
    15000,
  );
});
