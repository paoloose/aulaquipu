// Pruebas sin red: el SDK de AtomicMemory y fetch (para guardar) se simulan.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  initialize: vi.fn(async () => {}),
  search: vi.fn(async (req: unknown) => ({
    req,
    results: [] as Array<{ memory: { id: string; content: string } }>,
  })),
  delete: vi.fn(async (ref: unknown) => void ref),
  ctor: vi.fn(),
}));

vi.mock('@atomicmemory/sdk/browser', () => ({
  MemoryClient: class {
    constructor(config: unknown) {
      sdk.ctor(config);
    }
    initialize = sdk.initialize;
    search = sdk.search;
    delete = sdk.delete;
  },
}));

async function load() {
  vi.resetModules();
  return import('./memory.ts');
}

const KEY = 'secreto-de-prueba';

const providerResponse = async (url: string, init: RequestInit) => {
  void url;
  return init.method === 'DELETE'
    ? Response.json({ success: true })
    : Response.json({ stored_memory_ids: ['m1'] });
};
const ingestFetch = vi.fn(providerResponse);

describe('memoria de clases', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    ingestFetch.mockReset();
    ingestFetch.mockImplementation(providerResponse);
    vi.stubGlobal('fetch', ingestFetch);
    process.env.ATOMICMEMORY_API_URL = 'https://memoria.example.com';
    process.env.ATOMICMEMORY_API_KEY = KEY;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    warn.mockRestore();
    delete process.env.ATOMICMEMORY_API_URL;
    delete process.env.ATOMICMEMORY_API_KEY;
  });

  it('sin credenciales es un no-op y avisa una sola vez, sin tocar el SDK', async () => {
    delete process.env.ATOMICMEMORY_API_KEY;
    const m = await load();
    const scope = m.memoryScope('stu-1', 'ses-1');
    expect(await m.remember(scope, 'domina fracciones')).toBe(false);
    expect(await m.recallBrief(scope, 'progreso')).toBe('');
    expect(await m.remember(scope, 'otro')).toBe(false);
    expect(sdk.ctor).not.toHaveBeenCalled();
    expect(ingestFetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('guarda solo con el alumno como sujeto (sin session_id) y como resumen con extracción', async () => {
    const m = await load();
    expect(await m.remember(m.memoryScope('stu-1', 'ses-9'), ' Domina fracciones ')).toBe(true);
    expect(ingestFetch).toHaveBeenCalledTimes(1);
    const [url, init] = ingestFetch.mock.calls[0];
    expect(url).toBe('https://memoria.example.com/v1/memories/ingest');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    });
    expect(JSON.parse(String(init.body))).toEqual({
      user_id: 'stu-1',
      conversation: 'Domina fracciones',
      source_site: 'aulaquipu-tutor',
      content_class: 'summary',
    });
  });

  it('si el servicio rechaza el guardado devuelve false y avisa solo el código HTTP', async () => {
    ingestFetch.mockResolvedValueOnce(
      new Response(`{"error":"raw_content_rejected ${KEY}"}`, { status: 422 }),
    );
    const m = await load();
    expect(await m.remember(m.memoryScope('stu-1', 'ses-9'), 'dato privado del alumno')).toBe(
      false,
    );
    expect(warn).toHaveBeenCalledWith(
      '[memoria] sin memoria de clases: falló al guardar (HTTP 422)',
    );
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('dato privado');
  });

  it('si guardar tarda más de ~4 s, corta y no dice que guardó', async () => {
    vi.useFakeTimers();
    ingestFetch.mockImplementationOnce(() => new Promise(() => {}));
    const m = await load();
    const pending = m.remember(m.memoryScope('stu-1', 'ses-1'), 'Domina rectas');
    await vi.advanceTimersByTimeAsync(4_100);
    expect(await pending).toBe(false);
  });

  it('recuerda con la memoria del alumno (sin filtrar por clase) y arma viñetas', async () => {
    sdk.search.mockResolvedValueOnce({
      req: null,
      results: [
        { memory: { id: 'm1', content: 'Le cuesta\nsumar fracciones' } },
        { memory: { id: 'm2', content: '  ' } },
        { memory: { id: 'm3', content: 'Domina rectas' } },
      ],
    });
    const m = await load();
    const brief = await m.recallBrief(m.memoryScope('stu-1', 'ses-9'), 'progreso');
    expect(brief).toBe('- Le cuesta sumar fracciones\n- Domina rectas');
    expect(sdk.search).toHaveBeenCalledWith({
      query: 'progreso',
      scope: { user: 'stu-1' },
      limit: 5,
    });
  });

  it('si la API falla degrada a no-op, avisa una vez y no filtra contenido ni clave', async () => {
    ingestFetch.mockRejectedValue(new Error(`401 ${KEY}`));
    sdk.search.mockRejectedValue(new Error('caída'));
    const m = await load();
    const scope = m.memoryScope('stu-1', 'ses-1');
    expect(await m.remember(scope, 'dato privado del alumno')).toBe(false);
    expect(await m.recallBrief(scope, 'x')).toBe('');
    expect(await m.remember(scope, 'otro dato privado')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('dato privado');
  });

  it('si la API tarda más de ~4 s, corta y devuelve vacío', async () => {
    vi.useFakeTimers();
    sdk.search.mockImplementation(() => new Promise(() => {}));
    const m = await load();
    const pending = m.recallBrief(m.memoryScope('stu-1', 'ses-1'), 'x');
    await vi.advanceTimersByTimeAsync(4_100);
    expect(await pending).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('sin id de alumno no hace nada', async () => {
    const m = await load();
    expect(await m.remember(m.memoryScope('', 'ses-1'), 'algo')).toBe(false);
    expect(await m.recallBrief(m.memoryScope('', 'ses-1'), 'algo')).toBe('');
    expect(sdk.ctor).not.toHaveBeenCalled();
    expect(ingestFetch).not.toHaveBeenCalled();
  });

  describe('olvidar a pedido del alumno', () => {
    const recalled = {
      req: null,
      results: [
        { memory: { id: 'm1', content: 'Le cuesta sumar fracciones' } },
        { memory: { id: 'm2', content: 'Le cuesta restar fracciones' } },
        { memory: { id: 'm3', content: 'Domina rectas' } },
      ],
    };

    it('borra por id, en el scope del alumno, solo un registro que la clase ya consultó', async () => {
      sdk.search.mockResolvedValueOnce(recalled);
      const m = await load();
      const scope = m.memoryScope('stu-1', 'ses-9');
      await m.recallBrief(scope, 'progreso');
      expect(await m.forget(scope, 'le cuesta SUMAR fracciones.')).toEqual({
        kind: 'forgotten',
        content: 'Le cuesta sumar fracciones',
      });
      expect(ingestFetch).toHaveBeenCalledWith(
        'https://memoria.example.com/v1/memories/m1?user_id=stu-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
      // Ya olvidado: no se vuelve a borrar
      expect(await m.forget(scope, 'Le cuesta sumar fracciones')).toEqual({ kind: 'not_found' });
      expect(ingestFetch).toHaveBeenCalledTimes(1);
    });

    it('acepta un fragmento que identifique a uno solo; si coinciden varios no borra nada', async () => {
      sdk.search.mockResolvedValueOnce(recalled);
      const m = await load();
      const scope = m.memoryScope('stu-1', 'ses-9');
      await m.recallBrief(scope, 'progreso');
      expect(await m.forget(scope, 'fracciones')).toEqual({ kind: 'ambiguous' });
      expect(await m.forget(scope, 'rectas')).toEqual({
        kind: 'forgotten',
        content: 'Domina rectas',
      });
      expect(ingestFetch).toHaveBeenCalledTimes(1);
      expect(ingestFetch).toHaveBeenCalledWith(
        'https://memoria.example.com/v1/memories/m3?user_id=stu-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('no borra lo que no se consultó en esta clase ni lo consultado por otro alumno', async () => {
      sdk.search.mockResolvedValueOnce(recalled);
      const m = await load();
      const otherStudent = m.memoryScope('stu-2', 'ses-9');
      await m.recallBrief(m.memoryScope('stu-1', 'ses-9'), 'progreso');
      expect(await m.forget(otherStudent, 'Domina rectas')).toEqual({ kind: 'not_found' });
      expect(await m.forget(m.memoryScope('stu-1', 'ses-10'), 'Domina rectas')).toEqual({
        kind: 'not_found',
      });
      expect(ingestFetch).not.toHaveBeenCalled();
    });

    it('si el borrado falla lo informa como no disponible, sin filtrar la clave', async () => {
      sdk.search.mockResolvedValueOnce(recalled);
      ingestFetch.mockRejectedValueOnce(new Error(`500 ${KEY}`));
      const m = await load();
      const scope = m.memoryScope('stu-1', 'ses-9');
      await m.recallBrief(scope, 'progreso');
      expect(await m.forget(scope, 'Domina rectas')).toEqual({ kind: 'unavailable' });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    });
  });
  it('una clase compartida no consulta ni modifica la memoria del anfitrión', async () => {
    const m = await load();
    const scope = m.memoryScope('anfitrion', 'clase-compartida', true);
    expect(scope.studentId).toBe('');
    expect(await m.remember(scope, 'dato del alumno')).toBe(false);
    expect(await m.recallBrief(scope, 'progreso')).toBe('');
    expect(await m.forget(scope, 'dato del alumno')).toEqual({ kind: 'not_found' });
  });

  it('un recibo vacío nunca cuenta como guardado, pero HTTP 201 con id sí', async () => {
    const m = await load();
    const scope = m.memoryScope('stu-1', 'ses-1');
    ingestFetch.mockResolvedValueOnce(Response.json({}));
    expect(await m.remember(scope, 'Domina fracciones')).toBe(false);
    ingestFetch.mockResolvedValueOnce(
      Response.json({ stored_memory_ids: ['m1'] }, { status: 201 }),
    );
    expect(await m.remember(scope, 'Domina fracciones')).toBe(true);
  });

  it('un borrado sin confirmar conserva el registro para reintentar', async () => {
    sdk.search.mockResolvedValueOnce({
      results: [{ memory: { id: 'm1', content: 'Domina fracciones' } }],
    });
    const m = await load();
    const scope = m.memoryScope('stu-1', 'ses-1');
    await m.recallBrief(scope, 'progreso');
    ingestFetch.mockResolvedValueOnce(Response.json({ success: false }));
    expect(await m.forget(scope, 'Domina fracciones')).toEqual({ kind: 'unavailable' });
    expect(await m.forget(scope, 'Domina fracciones')).toEqual({
      kind: 'forgotten',
      content: 'Domina fracciones',
    });
  });

  it.each([
    'http://public.example',
    'https://key@memory.example',
    'https://memory.example?token=x',
  ])('rechaza la URL insegura %s sin enviar la clave', async (url) => {
    process.env.ATOMICMEMORY_API_URL = url;
    const m = await load();
    expect(await m.remember(m.memoryScope('stu-1', 'ses-1'), 'Domina fracciones')).toBe(false);
    expect(ingestFetch).not.toHaveBeenCalled();
  });
});
