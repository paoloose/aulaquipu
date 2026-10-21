// Memoria de clases con AtomicMemory (https://docs.atomicstrata.ai): qué trabajó y qué le costó
// a cada alumno. Sin credenciales, o si la API falla o tarda, se degrada a no-op: la clase sigue
// igual, solo sin memoria. Nunca se registran el contenido de los recuerdos ni las claves.
import { MemoryClient } from '@atomicmemory/sdk/browser';

export type MemoryScope = {
  readonly studentId: string;
  readonly sessionId: string;
  // Recuerdos que esta clase ya le mostró al tutor (por texto normalizado): solo estos se pueden
  // olvidar, así el modelo nunca elige un id a ciegas
  readonly recalled: Map<string, { id: string; content: string }>;
};

export type ForgetOutcome =
  | { kind: 'forgotten'; content: string }
  | { kind: 'ambiguous' }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

// Si solo hay clave, se usa el servicio público de AtomicMemory
const DEFAULT_API_URL = 'https://api.atomicstrata.ai';
const SOURCE = 'aulaquipu-tutor';

const TIMEOUT_MS = 4_000;
const MAX_BRIEF_CHARS = 1_200;
const MAX_RESULTS = 5;
// Un pedido de olvido por fragmento debe ser al menos así de específico
const MIN_FORGET_CHARS = 6;

export function memoryScope(
  studentId: string,
  sessionId: string,
  sharedClass = false,
): MemoryScope {
  return { studentId: sharedClass ? '' : studentId, sessionId, recalled: new Map() };
}

const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toLocaleLowerCase('es')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

let client: MemoryClient | null = null;
let ready: Promise<MemoryClient | null> | null = null;
let warned = false;

// Un solo aviso por proceso, sin contenido ni claves: solo el motivo
function warnOnce(reason: string) {
  if (warned) return;
  warned = true;
  console.warn(`[memoria] sin memoria de clases: ${reason}`);
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('tiempo agotado')), TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

type MemoryConfig = { apiUrl: string; apiKey: string };

// Las variables se leen aquí, no al importar: main.ts carga el .env después de sus imports
function memoryConfig(): MemoryConfig | null {
  const apiKey = process.env.ATOMICMEMORY_API_KEY;
  if (!apiKey) {
    warnOnce('falta ATOMICMEMORY_API_KEY');
    return null;
  }
  const apiUrl = (process.env.ATOMICMEMORY_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  try {
    const url = new URL(apiUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      warnOnce('URL de memoria no válida');
      return null;
    }
    return { apiUrl, apiKey };
  } catch {
    warnOnce('URL de memoria no válida');
    return null;
  }
}

function connect(): Promise<MemoryClient | null> {
  ready ??= (async () => {
    const config = memoryConfig();
    if (!config) return null;
    try {
      const memory = new MemoryClient({
        providers: { atomicmemory: { ...config, timeout: TIMEOUT_MS } },
      });
      await withTimeout(memory.initialize());
      client = memory;
      return memory;
    } catch (err) {
      warnOnce(`no se pudo conectar (${err instanceof Error ? err.name : 'error'})`);
      return null;
    }
  })();
  return ready;
}

class IngestRejected extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

// POST /v1/memories/ingest directo: el SDK 1.1.1 solo envía content_class en modo verbatim, y sin
// él un servicio con RAW_CONTENT_POLICY=reject rechaza el texto (422 raw_content_rejected). Se usa
// la ruta con extracción (no verbatim) para que una corrección del alumno actualice el registro
// anterior en vez de sumar otro (https://docs.atomicstrata.ai/api-reference/http/ingest-memory).
async function ingestSummary(config: MemoryConfig, studentId: string, note: string): Promise<void> {
  const res = await fetch(`${config.apiUrl}/v1/memories/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      // Solo user_id, sin session_id: en AtomicMemory Cloud un thread reemplaza al sujeto, y con el
      // id de la clase cada clase quedaba aparte y la siguiente nunca la encontraba
      // (https://docs.atomicstrata.ai/sdk/concepts/scopes-and-identity)
      user_id: studentId,
      conversation: note,
      source_site: SOURCE,
      // La nota la redacta el tutor como hecho breve: es un resumen, no la transcripción de la clase
      content_class: 'summary',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  });
  if (!res.ok) throw new IngestRejected(res.status);
  const body: unknown = await res.json();
  if (!body || typeof body !== 'object') throw new Error('guardado sin confirmar');
  const record = Object.fromEntries(Object.entries(body));
  const ids = [record.stored_memory_ids, record.updated_memory_ids].flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
  if (!ids.some((id) => typeof id === 'string' && id.trim()))
    throw new Error('guardado sin confirmar');
}

/** Guarda un hecho duradero del alumno. true solo si la API lo aceptó. */
export async function remember(scope: MemoryScope, content: string): Promise<boolean> {
  const text = content.trim();
  if (!scope.studentId || !text) return false;
  const config = memoryConfig();
  if (!config) return false;
  try {
    await withTimeout(ingestSummary(config, scope.studentId, text));
    return true;
  } catch (err) {
    const reason =
      err instanceof IngestRejected ? err.message : err instanceof Error ? err.name : 'error';
    warnOnce(`falló al guardar (${reason})`);
    return false;
  }
}

/** Resumen en viñetas de lo recordado del alumno sobre `query`; '' si no hay memoria o falla. */
export async function recallBrief(scope: MemoryScope, query: string): Promise<string> {
  if (!scope.studentId) return '';
  const memory = client ?? (await connect());
  if (!memory) return '';
  try {
    const page = await withTimeout(
      memory.search({ query, scope: { user: scope.studentId }, limit: MAX_RESULTS }),
    );
    const lines: string[] = [];
    for (const { memory: found } of page.results) {
      const content = oneLine(found.content);
      if (!content) continue;
      scope.recalled.set(normalize(content), { id: found.id, content });
      lines.push(`- ${content}`);
    }
    return lines.join('\n').slice(0, MAX_BRIEF_CHARS);
  } catch (err) {
    warnOnce(`falló al consultar (${err instanceof Error ? err.name : 'error'})`);
    return '';
  }
}

/**
 * Borra un recuerdo del alumno que esta clase ya consultó, a pedido del alumno. Se elige por su
 * texto (exacto o un fragmento que identifique a uno solo) y se borra en el scope del alumno.
 */
export async function forget(scope: MemoryScope, content: string): Promise<ForgetOutcome> {
  const wanted = normalize(content);
  if (!scope.studentId || !wanted) return { kind: 'not_found' };
  const exact = scope.recalled.get(wanted);
  const matches = exact
    ? [exact]
    : wanted.length >= MIN_FORGET_CHARS
      ? [...scope.recalled].filter(([text]) => text.includes(wanted)).map(([, entry]) => entry)
      : [];
  if (matches.length > 1) return { kind: 'ambiguous' };
  const [found] = matches;
  if (!found) return { kind: 'not_found' };
  const config = memoryConfig();
  if (!config) return { kind: 'unavailable' };
  try {
    const query = new URLSearchParams({ user_id: scope.studentId });
    const response = await fetch(
      `${config.apiUrl}/v1/memories/${encodeURIComponent(found.id)}?${query}`,
      {
        method: 'DELETE',
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${config.apiKey}` },
      },
    );
    if (response.status !== 404) {
      if (!response.ok) throw new Error('borrado sin confirmar');
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('success' in body) || body.success !== true)
        throw new Error('borrado sin confirmar');
    }
    scope.recalled.delete(normalize(found.content));
    return { kind: 'forgotten', content: found.content };
  } catch (err) {
    warnOnce(`falló al borrar (${err instanceof Error ? err.name : 'error'})`);
    return { kind: 'unavailable' };
  }
}
