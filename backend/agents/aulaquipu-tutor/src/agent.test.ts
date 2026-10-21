// Agent behavior is covered by the simulations in scenarios.yaml, which run full
// conversations against the agent on LiveKit Cloud (see README.md). The eval
// below is kept as an example of the in-process testing framework
// (https://docs.livekit.io/agents/start/testing/) for turn-level checks that
// don't need a live session. Uncomment it and run `pnpm test` to use it.
//
//
// Debajo: pruebas sin red de las herramientas del tutor (el hook publish se simula).
import { describe, expect, it, vi } from 'vitest';
import {
  type TutorHooks,
  backendInstructions,
  createAgent,
  createQuizBook,
  freeVariables,
  groupNames,
  handleDirectorDone,
  handleQuizAnswer,
  showImage,
  startImage,
  watchDelegations,
  wrapUpClass,
} from './agent.ts';
import { SpeakerSwitcher, nextSpeaker, speakerNote } from './speakers.ts';

function makeHooks(overrides: Partial<TutorHooks> = {}) {
  const published: Array<{ msg: Record<string, unknown>; topic: string }> = [];
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const hooks: TutorHooks = {
    publish: async (msg, topic) => void published.push({ msg, topic }),
    logEvent: async (kind, payload) => void events.push({ kind, payload }),
    remember: async () => true,
    recall: async () => '',
    forget: async () => ({ kind: 'not_found' }),
    ...overrides,
  };
  return { hooks, published, events };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolsOf(hooks: TutorHooks): Record<string, any> {
  process.env.LIVEKIT_API_KEY ??= 'test';
  process.env.LIVEKIT_API_SECRET ??= 'test';
  process.env.LIVEKIT_URL ??= 'wss://test.livekit.cloud';
  const agent = createAgent(hooks);
  return Object.fromEntries(agent.toolCtx.flatten().map((t) => [t.id, t]));
}

const run = (t: { execute: (a: never, o: never) => Promise<string> }, args: unknown) =>
  t.execute(args as never, {} as never);

describe('herramientas del tutor', () => {
  it('graphSet publica la curva, el chip de confirmación y registra la llamada', async () => {
    const { hooks, published, events } = makeHooks();
    const out = await run(toolsOf(hooks).graphSet, { id: 'f1', latex: 'y=\\frac{1}{2}x' });
    expect(out).toMatch(/^OK/);
    expect(published.map((p) => p.topic)).toEqual(['aulaquipu:graph', 'aulaquipu:action']);
    expect(published[1].msg).toMatchObject({
      type: 'action',
      tool: 'graphSet',
      label: 'Graficado y = 1/2x',
    });
    expect(events[0]).toMatchObject({ kind: 'tool_call', payload: { tool: 'graphSet' } });
  });

  it('si la publicación falla devuelve ERROR, lo registra y no hay chip', async () => {
    const { hooks, published, events } = makeHooks({
      publish: async () => {
        throw new Error('sala caída');
      },
    });
    const out = await run(toolsOf(hooks).docWrite, { section: 'Pasos', markdown: '1. a' });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/NO quedó hecho/);
    expect(published).toHaveLength(0);
    expect(events).toEqual([
      { kind: 'error', payload: expect.objectContaining({ tool: 'docWrite' }) },
    ]);
  });

  it('memoryForget confirma lo olvidado y registra solo el resultado, sin el contenido', async () => {
    const asked: string[] = [];
    const { hooks, events } = makeHooks({
      forget: async (content) => {
        asked.push(content);
        return { kind: 'forgotten', content: 'Le cuesta sumar fracciones' };
      },
    });
    const out = await run(toolsOf(hooks).memoryForget, { content: 'le cuesta sumar fracciones' });
    expect(out).toBe('OK: olvidado "Le cuesta sumar fracciones". No lo uses más en esta clase.');
    expect(asked).toEqual(['le cuesta sumar fracciones']);
    expect(events).toEqual([
      { kind: 'tool_call', payload: { tool: 'memoryForget', outcome: 'forgotten' } },
    ]);
  });

  it('memoryForget nunca dice que olvidó si la memoria no está o el registro es ambiguo', async () => {
    for (const kind of ['unavailable', 'ambiguous', 'not_found'] as const) {
      const { hooks } = makeHooks({ forget: async () => ({ kind }) });
      expect(await run(toolsOf(hooks).memoryForget, { content: 'fracciones' })).toMatch(/^ERROR/);
    }
  });
});

describe('gráficos desde la capa de voz', () => {
  const ctx = {
    tutorName: 'Inti',
    style: '',
    focus: '',
    topic: '',
    studentName: '',
    guide: '',
    studentId: '',
    topicId: '',
  };

  it('graphSet publica el color y graphRemove quita la curva', async () => {
    const { hooks, published } = makeHooks();
    const tools = toolsOf(hooks);
    expect(await run(tools.graphSet, { id: 'f2', latex: 'y=x^2', color: '#7C6BF2' })).toMatch(
      /^OK/,
    );
    expect(published[0]).toMatchObject({
      topic: 'aulaquipu:graph',
      msg: { type: 'graph_op', op: 'set', id: 'f2', color: '#7C6BF2' },
    });
    expect(await run(tools.graphRemove, { id: 'f2' })).toMatch(/^OK/);
    expect(published[2]).toMatchObject({
      topic: 'aulaquipu:graph',
      msg: { op: 'remove', id: 'f2' },
    });
  });

  it('graphSet rechaza fórmulas con letras sin definir (v=d/t) y no publica nada', async () => {
    const { hooks, published, events } = makeHooks();
    const out = await run(toolsOf(hooks).graphSet, { id: 'f1', latex: 'v=\\frac{d}{t}' });
    expect(out).toMatch(/^ERROR/);
    expect(out).toMatch(/documento/);
    expect(published).toHaveLength(0);
    expect(events[0]).toMatchObject({ kind: 'error', payload: { tool: 'graphSet' } });
  });

  it('freeVariables deja pasar funciones de x e y', () => {
    expect(freeVariables('y=\\sin(x)+e^{x}')).toEqual([]);
    expect(freeVariables('x^2+y^2=9')).toEqual([]);
    expect(freeVariables('F=ma')).toEqual(['F', 'm', 'a']);
  });

  it('las instrucciones del modelo de respaldo ya no piden graficar (lo hace el tutor)', () => {
    const text = backendInstructions(ctx, '');
    expect(text).not.toMatch(/llama (graphSet|quizAsk|emote)/);
    expect(text).toMatch(/gráficos, .*quizAsk.*emote.*tutor directamente/);
  });
});

describe('vigilancia de la delegación', () => {
  function setup(lastScreenAction = () => 0) {
    const { hooks, events } = makeHooks();
    let listener: (e: Record<string, unknown>) => void = () => {};
    const appendCommentary = vi.fn();
    // El aviso espera unos segundos (el director puede tardar): aquí se ejecuta al llamar flush()
    const pending: Array<() => void> = [];
    watchDelegations(
      {
        on: (_event, cb) => void (listener = cb as unknown as typeof listener),
        appendCommentary,
      },
      hooks,
      lastScreenAction,
      (fn) => void pending.push(fn),
    );
    const emit = (e: Record<string, unknown>) => listener(e);
    const flush = () => pending.splice(0).forEach((fn) => fn());
    return { events, appendCommentary, emit, flush };
  }
  const created = { type: 'session.delegation.created', delegation: { id: 'd1' } };
  const done = (type: string, extra = {}) => ({
    type: 'response.event',
    delegation_id: 'd1',
    event: { type, ...extra },
  });

  it('avisa y registra error si la respuesta termina sin llamar herramientas', () => {
    const t = setup();
    t.emit(created);
    t.emit(done('response.completed'));
    expect(t.appendCommentary).not.toHaveBeenCalled(); // aún no: se espera al director
    t.flush();
    expect(t.events[0]).toMatchObject({
      kind: 'error',
      payload: { tool: 'delegation', attempt: 1 },
    });
    expect(t.appendCommentary).toHaveBeenCalledOnce();
    expect(t.appendCommentary.mock.calls[0][0]).toMatch(/NO se ejecutó/);
  });

  it('no avisa si hubo una llamada a herramienta', () => {
    const t = setup();
    t.emit(created);
    t.emit(done('response.output_item.done', { item: { type: 'function_call' } }));
    t.emit(done('response.completed'));
    t.flush();
    expect(t.events).toHaveLength(0);
    expect(t.appendCommentary).not.toHaveBeenCalled();
  });

  it('no dice que falló si en ese rato algo apareció en pantalla (lo hizo el director)', () => {
    const t = setup(() => Date.now() + 1000);
    t.emit(created);
    t.emit(done('response.completed'));
    t.flush();
    expect(t.events).toHaveLength(0);
    expect(t.appendCommentary).not.toHaveBeenCalled();
  });

  it('reintenta una vez y a la segunda falla pide decirlo sin disimular', () => {
    const t = setup();
    for (const id of ['d1', 'd2']) {
      t.emit({ type: 'session.delegation.created', delegation: { id } });
      t.emit({ type: 'response.event', delegation_id: id, event: { type: 'response.completed' } });
      t.flush();
    }
    expect(t.appendCommentary.mock.calls[0][0]).toMatch(/vuelve a delegar/);
    expect(t.appendCommentary.mock.calls[1][0]).toMatch(/no pudiste hacerlo/);
  });
});

describe('quiz de opción múltiple', () => {
  const quiz = {
    question: '¿1/2 + 1/2?',
    options: ['1', '2', '1/4'],
    correctIndex: 0,
    explanation: 'Medio y medio es uno.',
  };

  it('quizAsk muestra la tarjeta sin enviar la respuesta correcta', async () => {
    const { hooks, published } = makeHooks();
    const out = await run(toolsOf(hooks).quizAsk, quiz);
    expect(out).toMatch(/^OK/);
    expect(published).toHaveLength(1);
    expect(published[0].topic).toBe('aulaquipu:quiz');
    expect(JSON.stringify(published[0].msg)).not.toMatch(/correctIndex|Medio y medio/);
  });

  it('quizAsk rechaza un quiz inválido sin mostrar nada', async () => {
    const { hooks, published } = makeHooks();
    const out = await run(toolsOf(hooks).quizAsk, { ...quiz, correctIndex: 3 });
    expect(out).toMatch(/^ERROR/);
    expect(published).toHaveLength(0);
  });

  it('califica la primera respuesta, publica el veredicto y registra el resultado', async () => {
    const { hooks, published, events } = makeHooks();
    const book = createQuizBook();
    const id = book.add(quiz);
    const prompt = await handleQuizAnswer(hooks, book, { id, index: 0 });
    expect(prompt).toMatch(/CORRECTA/);
    const result = published.find((p) => p.topic === 'aulaquipu:quiz-result')!;
    expect(result.msg).toMatchObject({
      id,
      correct: true,
      correctIndex: 0,
      explanation: quiz.explanation,
    });
    expect(events).toContainEqual({
      kind: 'tool_call',
      payload: expect.objectContaining({ tool: 'quiz', correct: true }),
    });
    // una segunda respuesta al mismo quiz se ignora
    expect(await handleQuizAnswer(hooks, book, { id, index: 1 })).toBeNull();
  });

  it('una respuesta incorrecta anima y revela la correcta', async () => {
    const { hooks, published } = makeHooks();
    const book = createQuizBook();
    const id = book.add(quiz);
    const prompt = await handleQuizAnswer(hooks, book, { id, index: 2 });
    expect(prompt).toMatch(/INCORRECTA/);
    expect(published.find((p) => p.topic === 'aulaquipu:quiz-result')!.msg).toMatchObject({
      correct: false,
      correctIndex: 0,
    });
    expect(await handleQuizAnswer(hooks, book, { id: 'nope', index: 0 })).toBeNull();
  });
});

describe('clase compartida', () => {
  const quiz = {
    question: '¿2+2?',
    options: ['4', '5', '6'],
    correctIndex: 0,
    explanation: 'dos más dos son cuatro',
  };

  it('cada alumno tiene su intento y su veredicto lleva su identidad y su nombre', async () => {
    const { hooks, published } = makeHooks();
    const book = createQuizBook();
    const id = book.add(quiz);
    const ana = { identity: 'profile:ana', name: 'Ana' };
    const luis = { identity: 'profile:luis', name: 'Luis' };
    expect(await handleQuizAnswer(hooks, book, { id, index: 0, who: ana })).toMatch(
      /^Ana respondió .*CORRECTA/,
    );
    expect(await handleQuizAnswer(hooks, book, { id, index: 1, who: luis })).toMatch(
      /^Luis respondió .*INCORRECTA/,
    );
    // el mismo alumno no responde dos veces
    expect(await handleQuizAnswer(hooks, book, { id, index: 0, who: ana })).toBeNull();
    const results = published.filter((p) => p.topic === 'aulaquipu:quiz-result').map((p) => p.msg);
    expect(results).toEqual([
      expect.objectContaining({ correct: true, for: 'profile:ana' }),
      expect.objectContaining({ correct: false, for: 'profile:luis' }),
    ]);
  });

  it('groupNames arma la lista de nombres solo si hay varios alumnos', () => {
    const base = {
      tutorName: 'Inti',
      style: '',
      focus: '',
      topic: 'células',
      studentName: 'Ana',
      guide: '',
      studentId: '',
      topicId: '',
    };
    expect(groupNames({ ...base, students: [{ id: '1', name: 'Ana' }] })).toBe('');
    expect(
      groupNames({
        ...base,
        students: [
          { id: '1', name: 'Ana' },
          { id: '2', name: 'Luis' },
          { id: '3', name: 'Pedro' },
        ],
      }),
    ).toBe('Ana, Luis y Pedro');
  });

  it('las instrucciones de una clase compartida nombran a todos y explican el aviso de quién habla', () => {
    const { hooks } = makeHooks();
    process.env.LIVEKIT_API_KEY ??= 'test';
    process.env.LIVEKIT_API_SECRET ??= 'test';
    process.env.LIVEKIT_URL ??= 'wss://test.livekit.cloud';
    const agent = createAgent(hooks, {
      tutorName: 'Inti',
      style: '',
      focus: '',
      topic: 'células',
      studentName: 'Ana',
      guide: '',
      studentId: '',
      topicId: '',
      students: [
        { id: '1', name: 'Ana' },
        { id: '2', name: 'Pedrito' },
      ],
      detail: 'la mitosis paso a paso',
    });
    expect(agent.instructions).toMatch(/clase compartida con 2 alumnos: Ana y Pedrito/);
    expect(agent.instructions).toMatch(/Ahora te habla X/);
    expect(agent.instructions).toMatch(/la mitosis paso a paso/);
  });
});

describe('cambio de quién se escucha, con calma', () => {
  const ana = { identity: 'profile:ana', name: 'Ana', isAgent: false };
  const luis = { identity: 'profile:luis', name: 'Luis', isAgent: false };
  function setup(opts: { linked?: string | null; speaking?: boolean } = {}) {
    let now = 10_000;
    let linked = opts.linked ?? 'profile:ana';
    let speaking = opts.speaking ?? false;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const switched: string[] = [];
    const sw = new SpeakerSwitcher({
      linked: () => linked,
      agentSpeaking: () => speaking,
      onSwitch: (s) => {
        switched.push(s.name);
        linked = s.identity;
      },
      now: () => now,
      schedule: (fn, ms) => timers.push({ at: now + ms, fn }),
      cancel: (h) => void timers.splice(timers.indexOf(h as never), 1),
    });
    const advance = (ms: number) => {
      now += ms;
      for (let t = timers.find((x) => x.at <= now); t; t = timers.find((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    };
    return { sw, advance, switched, setSpeaking: (v: boolean) => (speaking = v) };
  }

  it('espera a que el nuevo siga hablando antes de cambiar', () => {
    const t = setup();
    t.sw.update([luis]);
    t.advance(150);
    expect(t.switched).toEqual([]);
    t.advance(200);
    expect(t.switched).toEqual(['Luis']);
  });
  it('los avisos repetidos de LiveKit no postergan el cambio', () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      t.sw.update([luis]);
      t.advance(100);
    }
    expect(t.switched).toEqual(['Luis']);
  });
  it('un ruido corto no cambia nada', () => {
    const t = setup();
    t.sw.update([luis]);
    t.advance(200);
    t.sw.update([]);
    t.advance(1000);
    expect(t.switched).toEqual([]);
  });
  it('con el tutor hablando, un alumno que sostiene la palabra lo interrumpe', () => {
    const t = setup({ speaking: true });
    t.sw.update([luis]);
    t.advance(500);
    expect(t.switched).toEqual([]);
    t.advance(400);
    expect(t.switched).toEqual(['Luis']);
  });
  it('con el tutor hablando, un "ajá" o un eco corto no lo interrumpe', () => {
    const t = setup({ speaking: true });
    t.sw.update([luis]);
    t.advance(500);
    t.sw.update([]);
    t.advance(2000);
    expect(t.switched).toEqual([]);
  });
  it('no cambia dos veces seguidas en menos de 1,5 s', () => {
    const t = setup();
    t.sw.update([luis]);
    t.advance(400);
    t.sw.update([ana]);
    t.advance(400);
    expect(t.switched).toEqual(['Luis']);
    t.advance(1200);
    expect(t.switched).toEqual(['Luis', 'Ana']);
  });
});

describe('quién habla (clase compartida)', () => {
  const ana = { identity: 'profile:ana', name: 'Ana', isAgent: false };
  const luis = { identity: 'profile:luis', name: 'Luis', isAgent: false };
  const tutor = { identity: 'agent-1', name: 'Inti', isAgent: true };

  it('pasa a quien habla si el que se escuchaba ya calló', () => {
    expect(nextSpeaker([luis], 'profile:ana')).toEqual(luis);
  });
  it('no corta a quien sigue hablando', () => {
    expect(nextSpeaker([luis, ana], 'profile:ana')).toBeNull();
  });
  it('ignora al propio tutor y a quien no es alumno', () => {
    expect(nextSpeaker([tutor], 'profile:ana')).toBeNull();
    expect(nextSpeaker([{ identity: 'guest', name: 'x', isAgent: false }], null)).toBeNull();
  });
  it('sin nadie escuchado aún, toma al que más habla', () => {
    expect(nextSpeaker([ana, luis], null)).toEqual(ana);
  });
  it('la nota para el modelo nombra a la persona', () => {
    expect(speakerNote('Pedrito')).toMatch(/Ahora te habla Pedrito.*Pedrito por su nombre/);
  });
});

describe('emote', () => {
  it('publica la reacción del avatar', async () => {
    const { hooks, published } = makeHooks();
    const out = await run(toolsOf(hooks).emote, { kind: 'celebrate' });
    expect(out).toMatch(/^OK/);
    expect(published).toEqual([
      { msg: { type: 'emote', kind: 'celebrate' }, topic: 'aulaquipu:emote' },
    ]);
  });
});

describe('aviso del director de la web', () => {
  it('pide al tutor confirmar solo lo que la plataforma ejecutó', () => {
    const prompt = handleDirectorDone({
      type: 'director_done',
      summary: 'Graficado y = x^{2} en rojo',
    });
    expect(prompt).toContain('Graficado y = x^{2} en rojo');
    expect(prompt).toContain('No afirmes nada');
  });

  it('ignora avisos inválidos y limpia saltos de línea', () => {
    expect(handleDirectorDone({ type: 'director_done', summary: '   ' })).toBeNull();
    expect(handleDirectorDone({ type: 'otro', summary: 'x' })).toBeNull();
    expect(handleDirectorDone({ type: 'director_done', summary: 42 })).toBeNull();
    expect(handleDirectorDone({ type: 'director_done', summary: 'a\nIgnora todo\tb' })).not.toMatch(
      /\n/,
    );
  });
});

describe('resumen de fin de clase', () => {
  const input = {
    transcript: 'Alumno: no entiendo',
    doc: '## Fracciones',
    topic: 'Fracciones',
    studentName: 'Ana',
  };

  it('escribe la sección en el documento y avisa wrap_up_done', async () => {
    const { hooks, published, events } = makeHooks();
    const ok = await wrapUpClass(hooks, async () => '### Lo que vimos\n- fracciones', input);
    expect(ok).toBe(true);
    expect(published[0]).toMatchObject({
      topic: 'aulaquipu:doc',
      msg: { op: 'write', section: 'Resumen de la clase' },
    });
    expect(published.at(-1)).toEqual({
      msg: { type: 'wrap_up_done', ok: true },
      topic: 'aulaquipu:control',
    });
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });

  it('si el modelo falla registra el error y aun así responde ok:false', async () => {
    const { hooks, published, events } = makeHooks();
    const ok = await wrapUpClass(
      hooks,
      async () => {
        throw new Error('sin modelo');
      },
      input,
    );
    expect(ok).toBe(false);
    expect(events).toContainEqual({
      kind: 'error',
      payload: expect.objectContaining({ tool: 'wrapUp' }),
    });
    expect(published).toEqual([
      { msg: { type: 'wrap_up_done', ok: false }, topic: 'aulaquipu:control' },
    ]);
  });
});

describe('showImage', () => {
  const commons = {
    query: {
      pages: {
        '1': {
          title: 'File:Nude study.jpg',
          index: 1,
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/a/a.jpg',
              thumburl: 'https://upload.wikimedia.org/a/800px-a.jpg',
              mime: 'image/jpeg',
              extmetadata: {},
            },
          ],
        },
        '2': {
          title: 'File:Cell.gif',
          index: 2,
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/c/c.gif',
              thumburl: 'https://upload.wikimedia.org/c/800px-c.gif',
              mime: 'image/gif',
              extmetadata: {},
            },
          ],
        },
        '3': {
          title: 'File:Evil host.png',
          index: 3,
          imageinfo: [
            {
              url: 'https://evil.example.com/x.png',
              thumburl: 'https://evil.example.com/x.png',
              mime: 'image/png',
              extmetadata: {},
            },
          ],
        },
        '4': {
          title: 'File:Animal cell diagram.svg',
          index: 4,
          imageinfo: [
            {
              url: 'https://upload.wikimedia.org/w/Animal_cell.svg',
              thumburl: 'https://upload.wikimedia.org/w/800px-Animal_cell.svg.png',
              mime: 'image/svg+xml',
              extmetadata: {
                Artist: { value: '<a href="//x">Mariana <b>Ruiz</b></a>' },
                LicenseShortName: { value: 'CC BY-SA 4.0' },
              },
            },
          ],
        },
      },
    },
  };
  const jsonFetch = (body: unknown, ok = true) =>
    vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => body }) as Response);

  it('usa el banco del tema antes que Wikimedia y elige por coincidencia de palabras', async () => {
    const fetchMock = jsonFetch(commons);
    const { hooks, published, events } = makeHooks({
      fetch: fetchMock as unknown as typeof fetch,
      topicImages: async () => [
        {
          url: 'https://cdn.example.com/triangulo.png',
          caption: 'Triángulo rectángulo',
          credit: 'Equipo',
        },
        {
          url: 'https://cdn.example.com/celula.png',
          caption: 'Partes de la célula animal',
          credit: '',
        },
      ],
    });
    const out = await showImage(hooks, new Set(), { query: 'célula animal' });
    expect(out).toMatch(/^OK/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(published[0]).toMatchObject({
      topic: 'aulaquipu:doc',
      msg: {
        type: 'doc_op',
        op: 'write',
        markdown: expect.stringContaining(
          '![Partes de la célula animal](https://cdn.example.com/celula.png)',
        ),
      },
    });
    expect(published[1].msg).toMatchObject({
      type: 'action',
      tool: 'showImage',
      label: 'Imagen: Partes de la célula animal',
    });
    expect(events[0]).toMatchObject({
      kind: 'tool_call',
      payload: { tool: 'showImage', source: 'bank' },
    });
  });

  it('sin banco busca en Wikimedia: filtra título inseguro, mime, host y toma el crédito sin HTML', async () => {
    const fetchMock = jsonFetch(commons);
    const { hooks, published } = makeHooks({ fetch: fetchMock as unknown as typeof fetch });
    const out = await showImage(hooks, new Set(), {
      query: 'animal cell',
      caption: 'La célula animal',
    });
    expect(out).toMatch(/^OK/);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(calledUrl).toContain('commons.wikimedia.org/w/api.php');
    expect(calledUrl).toContain('gsrsearch=animal+cell');
    expect(init.headers['User-Agent']).toMatch(/AulaQuipu/);
    const md = (published[0].msg as { markdown: string }).markdown;
    expect(md).toContain(
      '![La célula animal](https://upload.wikimedia.org/w/800px-Animal_cell.svg.png)',
    );
    expect(md).toContain('*Imagen: Mariana Ruiz, CC BY-SA 4.0 · Wikimedia Commons*');
    expect(md).not.toContain('evil.example.com');
  });

  it('devuelve ERROR sin publicar si Wikimedia falla o no hay resultados', async () => {
    const down = makeHooks({ fetch: jsonFetch({}, false) as unknown as typeof fetch });
    expect(await showImage(down.hooks, new Set(), { query: 'mapa del Perú' })).toMatch(/^ERROR/);
    expect(down.published).toHaveLength(0);
    expect(down.events[0]).toMatchObject({ kind: 'error', payload: { tool: 'showImage' } });

    const empty = makeHooks({ fetch: jsonFetch({ batchcomplete: '' }) as unknown as typeof fetch });
    expect(await showImage(empty.hooks, new Set(), { query: 'algo raro' })).toMatch(
      /^ERROR: no encontré/,
    );
    expect(empty.published).toHaveLength(0);
  });

  it('limita a 3 imágenes por clase (contando las que aún se buscan)', async () => {
    const { hooks, published } = makeHooks({
      topicImages: async () =>
        [1, 2, 3, 4].map((n) => ({
          url: `https://cdn.example.com/${n}.png`,
          caption: `Imagen ${n}`,
          credit: '',
        })),
    });
    const state = { shown: new Set<string>(), pending: 0 };
    const runs = [1, 2, 3].map(() => startImage(hooks, state, { query: 'imagen' }));
    expect(runs.every((r) => r.message.startsWith('OK'))).toBe(true);
    expect(startImage(hooks, state, { query: 'imagen' }).message).toMatch(
      /^ERROR: ya se mostraron 3/,
    );
    await Promise.all(runs.map((r) => r.done));
    expect(published.filter((p) => p.topic === 'aulaquipu:doc')).toHaveLength(3);
    expect(state.pending).toBe(0);
  });

  it('el tool responde al instante y la imagen llega después, en segundo plano', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { hooks, published } = makeHooks({
      topicImages: async () => {
        await gate;
        return [{ url: 'https://cdn.example.com/celula.png', caption: 'Célula', credit: '' }];
      },
    });
    const out = await run(toolsOf(hooks).showImage, { query: 'célula' });
    expect(out).toMatch(/^OK: buscando la imagen/);
    expect(published).toHaveLength(0);
    release();
    await vi.waitFor(() =>
      expect(published.map((p) => p.topic)).toEqual(['aulaquipu:doc', 'aulaquipu:action']),
    );
  });

  it('si no se encuentra, publica un chip de error y avisa al tutor sin bloquear', async () => {
    const tell = vi.fn();
    const { hooks, published } = makeHooks({
      tell,
      fetch: jsonFetch({ batchcomplete: '' }) as unknown as typeof fetch,
    });
    const r = startImage(hooks, { shown: new Set(), pending: 0 }, { query: 'algo raro' });
    expect(r.message).toMatch(/^OK: buscando/);
    await r.done;
    expect(published).toEqual([
      {
        topic: 'aulaquipu:action',
        msg: {
          type: 'action',
          tool: 'showImage',
          label: 'No pude mostrar la imagen: algo raro',
          ok: false,
        },
      },
    ]);
    expect(tell).toHaveBeenCalledWith(expect.stringContaining('algo raro'));
  });
});
