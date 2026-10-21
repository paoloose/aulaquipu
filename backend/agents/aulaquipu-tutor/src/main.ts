import { ServerOptions, cli, defineAgent, inference, llm, voice } from '@livekit/agents';
import { ParticipantKind, RoomEvent } from '@livekit/rtc-node';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import {
  type ClassContext,
  createAgent,
  createQuizBook,
  groupNames,
  handleDirectorDone,
  handleQuizAnswer,
  watchDelegations,
  wrapUpClass,
} from './agent.ts';
import { fetchTopicImages } from './images.ts';
import { forget, memoryScope, recallBrief, remember } from './memory.ts';
import { SpeakerSwitcher, speakerNote } from './speakers.ts';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '../../.env' });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sessionIdFromRoom(roomName: string | undefined): string | null {
  const match = /^session-([0-9a-fA-F-]{36})$/.exec(roomName ?? '');
  return match?.[1] ?? null;
}

// La web app despacha al agente con metadata JSON: tutor elegido, tema y alumno.
function classContextFrom(metadata: string | undefined): ClassContext {
  try {
    const raw = JSON.parse(metadata || '{}') as Partial<ClassContext>;
    return {
      tutorName: typeof raw.tutorName === 'string' && raw.tutorName ? raw.tutorName : 'Quipu',
      style: typeof raw.style === 'string' ? raw.style : '',
      focus: typeof raw.focus === 'string' ? raw.focus : '',
      topic: typeof raw.topic === 'string' ? raw.topic : '',
      studentName: typeof raw.studentName === 'string' ? raw.studentName : '',
      // Tope defensivo: la web ya la recorta, pero el metadata viene de fuera del proceso
      guide: typeof raw.guide === 'string' ? raw.guide.trim().slice(0, 4500) : '',
      studentId: typeof raw.studentId === 'string' ? raw.studentId : '',
      topicId: typeof raw.topicId === 'string' ? raw.topicId : '',
      // Clase compartida (hasta 5): ids y nombres, con topes defensivos
      students: Array.isArray(raw.students)
        ? raw.students
            .filter(
              (s): s is { id: string; name: string } =>
                !!s && typeof s.id === 'string' && typeof s.name === 'string',
            )
            .slice(0, 5)
            .map((s) => ({ id: s.id.slice(0, 64), name: s.name.trim().slice(0, 40) }))
            .filter((s) => s.name)
        : [],
      detail: typeof raw.detail === 'string' ? raw.detail.trim().slice(0, 280) : '',
    };
  } catch {
    return {
      tutorName: 'Quipu',
      style: '',
      focus: '',
      topic: '',
      studentName: '',
      guide: '',
      studentId: '',
      topicId: '',
    };
  }
}

export default defineAgent({
  entry: async (ctx) => {
    // El nombre de la sala viene en el job: ctx.room.name sigue vacío hasta ctx.connect()
    const sessionId = sessionIdFromRoom(ctx.job.room?.name ?? ctx.room.name);
    const klass = classContextFrom(ctx.job.metadata);
    // Una línea por sesión, sin volcar el contenido de la guía
    console.log(
      `[tutor] sesión ${sessionId ?? '?'}: guía del tema ${klass.guide ? `aplicada (${klass.guide.length} caracteres)` : 'no definida'}`,
    );

    // Última vez que algo apareció en pantalla (herramienta del agente o acción del director):
    // así el vigilante de delegaciones no avisa "no se ejecutó" de algo que sí salió
    let lastScreenAction = 0;
    const SCREEN_TOPICS = new Set([
      'aulaquipu:graph',
      'aulaquipu:doc',
      'aulaquipu:quiz',
      'aulaquipu:action',
    ]);
    const publish = async (msg: Record<string, unknown>, topic: string) => {
      const local = ctx.room.localParticipant;
      // Falla en voz alta: si no sale, la herramienta debe devolver ERROR y no un falso "OK"
      if (!local) throw new Error('la sala no está disponible');
      await local.publishData(encoder.encode(JSON.stringify(msg)), {
        reliable: true,
        topic,
      });
      if (SCREEN_TOPICS.has(topic)) lastScreenAction = Date.now();
    };

    const logEvent = async (kind: string, payload: Record<string, unknown>) => {
      if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !sessionId) return;
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/session_events`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({
            session_id: sessionId,
            actor: 'ai:aulaquipu-tutor',
            kind,
            payload,
          }),
        });
        if (!res.ok) {
          console.warn(
            'no se pudo registrar session_event',
            res.status,
            (await res.text()).slice(0, 300),
          );
        }
      } catch (err) {
        console.warn('no se pudo registrar session_event', err);
      }
    };

    const session = new voice.AgentSession({});

    const group = groupNames(klass);
    // Una clase compartida no debe consultar ni modificar la memoria privada del anfitrión.
    const scope = memoryScope(klass.studentId, sessionId ?? '', Boolean(group));
    const hooks = {
      publish,
      logEvent,
      remember: (content: string) => remember(scope, content),
      recall: (query: string) => recallBrief(scope, query),
      forget: (content: string) => forget(scope, content),
      // Aviso del agente al tutor de voz (p. ej. la imagen que se buscaba en segundo plano no apareció)
      tell: (instructions: string) => {
        try {
          session.generateReply({ instructions });
        } catch (err) {
          console.warn('no se pudo avisar al tutor', err);
        }
      },
      topicImages: () =>
        fetchTopicImages({ url: SUPABASE_URL, key: SUPABASE_SECRET_KEY }, klass.topicId),
    };
    const memoryBrief = await hooks.recall(
      klass.topic
        ? `progreso del alumno en ${klass.topic}`
        : 'progreso del alumno y temas vistos en clases anteriores',
    );

    const quizzes = createQuizBook();
    const agent = createAgent(hooks, klass, memoryBrief, quizzes);
    await session.start({ agent, room: ctx.room });

    // Clase compartida: el agente escucha a una persona a la vez. Se pasa a quien está hablando
    // (cuando quien se escuchaba ya calló) y se le dice al modelo su nombre para que le responda.

    let speakerName = klass.studentName;
    const listenTo = async (identity: string, name: string) => {
      const io = session._roomIO;
      if (!io || io.linkedParticipant?.identity === identity) return;
      io.setParticipant(identity);
      speakerName = name || speakerName;
      try {
        // Solo la nota, como contexto silencioso: con updateChatCtx cada cambio diferenciaba el
        // historial completo y la nota de sistema se sumaba a las instrucciones permanentes
        (agent.duplexSession as unknown as { appendThinking(text: string): void }).appendThinking(
          speakerNote(speakerName),
        );
      } catch (err) {
        console.warn(
          '[tutor] no se pudo avisar quién habla',
          err instanceof Error ? err.message : err,
        );
      }
    };
    if (group) {
      const switcher = new SpeakerSwitcher({
        linked: () => session._roomIO?.linkedParticipant?.identity ?? null,
        agentSpeaking: () => session.agentState === 'speaking',
        onSwitch: (s) => void listenTo(s.identity, s.name),
      });
      ctx.room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const self = ctx.room.localParticipant?.identity;
        switcher.update(
          speakers.map((p) => ({
            identity: p.identity,
            name: p.name || '',
            isAgent: p.identity === self || ('kind' in p && p.kind === ParticipantKind.AGENT),
          })),
        );
      });
      ctx.addShutdownCallback(async () => switcher.dispose());
      // Si se va la persona que se escuchaba, se pasa a otro alumno que siga en la sala
      ctx.room.on(RoomEvent.ParticipantDisconnected, (gone) => {
        if (
          session._roomIO?.linkedParticipant &&
          session._roomIO.linkedParticipant.identity !== gone.identity
        )
          return;
        const next = [...ctx.room.remoteParticipants.values()].find(
          (p) =>
            p.identity !== gone.identity &&
            p.kind !== ParticipantKind.AGENT &&
            p.identity.startsWith('profile:'),
        );
        if (next) void listenTo(next.identity, next.name || '');
      });
    }

    // Si el modelo de respaldo termina sin llamar herramientas, se registra y el tutor lo dice
    try {
      watchDelegations(
        agent.duplexSession as unknown as Parameters<typeof watchDelegations>[0],
        hooks,
        () => lastScreenAction,
      );
    } catch (err) {
      console.warn('no se pudo vigilar la delegación', err);
    }

    // Transcripción corrida de la clase, para el resumen de cierre
    const transcript: string[] = [];
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
      const item = ev.item;
      if (item.type !== 'message' || !item.textContent) return;
      const who =
        item.role === 'user' ? (group ? speakerName || 'Alumno' : 'Alumno') : klass.tutorName;
      transcript.push(`${who}: ${item.textContent.slice(0, 400)}`);
      if (transcript.length > 80) transcript.shift();
    });
    const generateSummary = async (prompt: string) => {
      const model = new inference.LLM({ model: 'openai/gpt-4.1-mini' });
      try {
        const chatCtx = llm.ChatContext.empty();
        chatCtx.addMessage({ role: 'user', content: prompt });
        return (await model.chat({ chatCtx }).collect()).text;
      } finally {
        await model.aclose();
      }
    };
    let wrappingUp = false;

    const QUIZ_BATCH_MS = 3500;
    let quizBatch: string[] = [];
    let quizTimer: ReturnType<typeof setTimeout> | null = null;
    const queueQuizReaction = (prompt: string) => {
      quizBatch.push(prompt);
      quizTimer ??= setTimeout(() => {
        const batch = quizBatch;
        quizBatch = [];
        quizTimer = null;
        session.generateReply({
          instructions:
            batch.length === 1
              ? batch[0]!
              : `Varios alumnos respondieron la pregunta. ${batch.join(' ')} Reacciona a todos en UNA sola intervención breve: nómbralos, felicita a quienes acertaron, anima a quienes no y explica la respuesta correcta una sola vez.`,
        });
      }, QUIZ_BATCH_MS);
    };

    // Mensajes del alumno al agente: respuestas a las tarjetas de quiz y cierre de clase
    ctx.room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (!participant || participant.kind === ParticipantKind.AGENT) return;
      let msg: { type?: unknown; id?: unknown; index?: unknown; doc?: unknown; summary?: unknown };
      try {
        msg = JSON.parse(decoder.decode(payload));
      } catch {
        return;
      }
      if (topic === 'aulaquipu:quiz-answer' && msg.type === 'quiz_answer') {
        if (typeof msg.id !== 'string' || typeof msg.index !== 'number') return;
        // Quién respondió: cada alumno tiene su propio intento y su propio veredicto
        const who = { identity: participant.identity, name: participant.name || '' };
        void handleQuizAnswer(hooks, quizzes, { id: msg.id, index: msg.index, who }).then(
          (prompt) => {
            if (!prompt) return;
            // Clase compartida: las respuestas que llegan juntas se comentan en una sola intervención
            // (una por alumno hacía esperar y se pisaban)
            if (group) return queueQuizReaction(prompt);
            session.generateReply({ instructions: prompt });
          },
        );
      } else if (topic === 'aulaquipu:control' && msg.type === 'director_done') {
        // La web ya graficó / preguntó / mostró algo: el tutor lo confirma sin inventar nada
        const prompt = handleDirectorDone(msg as { type?: unknown; summary?: unknown });
        if (prompt) session.generateReply({ instructions: prompt });
      } else if (topic === 'aulaquipu:control' && msg.type === 'wrap_up' && !wrappingUp) {
        wrappingUp = true;
        void wrapUpClass(hooks, generateSummary, {
          transcript: transcript.join('\n'),
          doc: typeof msg.doc === 'string' ? msg.doc.slice(0, 12000) : '',
          topic: klass.topic,
          studentName: group || klass.studentName,
        }).finally(() => {
          wrappingUp = false;
        });
      }
    });

    await ctx.connect();
    await logEvent('join', { name: klass.tutorName, guide: !!klass.guide });

    const who = group
      ? ` a ${group}`
      : klass.studentName
        ? ` a ${klass.studentName}`
        : ' al alumno';
    session.generateReply({
      instructions: group
        ? `Saluda como ${klass.tutorName}${who}, por sus nombres. Di que hoy trabajarán ${klass.topic || 'el tema que eligieron'} juntos y haz tu primera pregunta de diagnóstico a uno de ellos por su nombre. Sé breve y cercano.`
        : klass.topic
          ? `Saluda como ${klass.tutorName}${who}, di que hoy trabajarán ${klass.topic} y haz tu primera pregunta de diagnóstico. Sé breve y cercano.`
          : `Saluda como ${klass.tutorName}${who} y pregunta qué tema quiere trabajar hoy. Sé breve y cercano.`,
    });
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'aulaquipu-tutor',
  }),
);
