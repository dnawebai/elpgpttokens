/**
 * Intent classification for ELPGPT auto-routing.
 *
 * Reads what the user is typing (or just sent) and decides which kind of model
 * should answer it: a web-grounded search model for "what's the latest…", an
 * image model for "draw me…", a strong coding model for a stack trace, and so
 * on. elp-router.ts turns the intent into a concrete provider + model.
 *
 * Deliberately deterministic and dependency-free: it runs on every keystroke
 * (debounced) for the live "routing to…" badge in /chat, so it must answer in
 * microseconds, cost nothing, and give the same answer for the same text. The
 * patterns cover English, Spanish and Portuguese; accents are folded before
 * matching, so "búsqueda" and "busqueda" are the same word.
 *
 * Scoring: each intent sums the weights of the patterns it matches; the
 * highest score wins, ties broken by INTENT_PRIORITY. A few structural rules
 * run first because they are decisive on their own (an explicit /image
 * command, an attached image with no generation verb).
 */

export const ELP_INTENTS = [
  'image_generation',
  'web_search',
  'translation',
  'code',
  'reasoning',
  'writing',
  'vision',
  'chat',
] as const;

export type ElpIntent = typeof ELP_INTENTS[number];

export function isElpIntent(value: unknown): value is ElpIntent {
  return typeof value === 'string' && (ELP_INTENTS as readonly string[]).includes(value);
}

export interface IntentSignals {
  /** The message carries an image attachment (vision input). */
  hasImageAttachment?: boolean;
  /** Intent of the previous user turn, for follow-ups like "make it blue". */
  previousIntent?: ElpIntent;
}

export interface IntentResult {
  intent: ElpIntent;
  /** 0..1. 1 for decisive structural rules, lower for score-based picks. */
  confidence: number;
  /** Short machine-friendly explanation, e.g. `keyword:"latest news"`. */
  reason: string;
  /** For translation: the target language named in the prompt, if any (ISO-ish code). */
  targetLanguage?: string;
}

/** Tie-break order when two intents score the same. Earlier wins. */
const INTENT_PRIORITY: readonly ElpIntent[] = [
  'image_generation',
  'translation',
  'web_search',
  'code',
  'reasoning',
  'writing',
  'vision',
  'chat',
];

interface Rule {
  intent: ElpIntent;
  weight: number;
  pattern: RegExp;
}

// Patterns run against accent-folded, lower-cased text, so write them without
// accents ("busqueda", not "búsqueda").
const GEN_VERB = String.raw`(?:generate|create|make|draw|design|paint|render|sketch|illustrate|imagine|produce|genera|generar|crea|crear|dibuja|dibujar|disena|disenar|pinta|pintar|haz|hazme|gera|gerar|cria|criar|desenha|desenhe|desenhar|faca|fazer)`;
const IMAGE_NOUN = String.raw`(?:image|images|picture|pictures|photo|photos|illustration|drawing|logo|logotype|poster|wallpaper|icon|artwork|painting|portrait|banner|thumbnail|sticker|avatar|mockup|imagen|imagenes|foto|fotos|ilustracion|dibujo|cartel|retrato|imagem|imagens|ilustracao|desenho|pintura)`;

const RULES: readonly Rule[] = [
  // ---- image generation ----
  { intent: 'image_generation', weight: 6, pattern: new RegExp(String.raw`\b${GEN_VERB}\b(?:\s+\S+){0,5}?\s+\b${IMAGE_NOUN}\b`) },
  { intent: 'image_generation', weight: 4, pattern: new RegExp(String.raw`\b${IMAGE_NOUN}\s+(?:of|de|do|da)\b`) },
  { intent: 'image_generation', weight: 4, pattern: /\b(?:photorealistic|fotorrealista|fotorealista|4k|8k|watercolor|acuarela|aquarela|oil painting|pixel art|anime style|estilo anime|cinematic lighting|digital art)\b/ },
  { intent: 'image_generation', weight: 3, pattern: /\b(?:draw|dibuja|desenha|desenhe|paint|pinta)\b/ },

  // ---- translation ----
  { intent: 'translation', weight: 7, pattern: /\b(?:translate|translation|traduce|traducir|traduceme|traduccion|traduzca|traduzir|traduza|traducao|traduz)\b/ },
  { intent: 'translation', weight: 5, pattern: /\bhow (?:do you|do i|to|would you) say\b|\bcomo se dice\b|\bcomo se diz\b|\bcomo dizer\b/ },
  { intent: 'translation', weight: 3, pattern: /\b(?:in|into|to|al|en|para o|para)\s+(?:english|spanish|french|german|italian|portuguese|chinese|japanese|korean|arabic|russian|hindi|ingles|espanol|castellano|frances|aleman|italiano|portugues|chino|japones|coreano|arabe|ruso|espanhol|alemao|chines)\b/ },

  // ---- web search / fresh information ----
  { intent: 'web_search', weight: 6, pattern: /\b(?:search|google|look up|lookup|browse the web|search the web|on the internet|online sources|busca|buscar|busqueda|investiga en internet|en internet|en la web|pesquisa|pesquisar|procure|procurar|na internet)\b/ },
  { intent: 'web_search', weight: 5, pattern: /\b(?:latest|newest|breaking|news|headlines|today|tonight|yesterday|this week|this month|right now|up to date|ultimas?|ultimos?|noticias?|hoy|ayer|esta semana|este mes|ahora mismo|hoje|ontem|esta semana)\b/ },
  // Softer freshness words: a hint, not decisive ("current directory" is code).
  // English "actual" means "real", so only the unambiguous Spanish/Portuguese
  // adverbs are listed.
  { intent: 'web_search', weight: 3, pattern: /\b(?:currently|current|recent|recently|actualmente|reciente|recientes|atualmente|atual|recentes?|agora)\b/ },
  { intent: 'web_search', weight: 4, pattern: /\b(?:price of|stock price|share price|exchange rate|weather|forecast|score|who won|election|release date|when is|precio de|cotizacion|tipo de cambio|clima|pronostico|quien gano|resultado del partido|preco de|cotacao|previsao do tempo|quem ganhou)\b/ },
  { intent: 'web_search', weight: 3, pattern: /\b20(?:2[5-9]|3\d)\b/ },
  { intent: 'web_search', weight: 2, pattern: /\b(?:sources?|citations?|cite|fuentes?|fontes?|links?)\b/ },

  // ---- code ----
  { intent: 'code', weight: 7, pattern: /```|\bstack ?trace\b|\btraceback\b|\bsyntaxerror\b|\btypeerror\b|\bnullpointer|\bsegfault\b|\bundefined is not\b/ },
  { intent: 'code', weight: 5, pattern: /\b(?:code|coding|function|method|class|bug|debug|refactor|compile|compiler|regex|regexp|api|endpoint|sql|query|database|typescript|javascript|python|java|golang|rust|kotlin|swift|php|ruby|c\+\+|c#|react|vue|angular|next\.?js|node\.?js|django|flask|css|html|json|yaml|docker|kubernetes|git|github|npm|bash|shell script|unit test|codigo|programa|programar|funcion|funcao|depurar|consulta sql|base de datos|banco de dados)\b/ },
  { intent: 'code', weight: 4, pattern: /(?:^|\n)\s*(?:def |class |function |const |let |import |from \S+ import|#include|public static|SELECT |select .+ from )|=>|\)\s*\{|;\s*$/m },

  // ---- reasoning / math / analysis ----
  { intent: 'reasoning', weight: 5, pattern: /\b(?:prove|proof|solve|calculate|compute|equation|derivative|integral|probability|theorem|optimi[sz]e|step by step|logic puzzle|riddle|demuestra|demostrar|resuelve|resolver|calcula|calcular|ecuacion|derivada|probabilidad|paso a paso|resolva|calcule|equacao|probabilidade|passo a passo)\b/ },
  { intent: 'reasoning', weight: 4, pattern: /\b(?:analy[sz]e|analysis|compare|comparison|pros and cons|trade-?offs?|evaluate|strategy|plan for|business plan|decide between|analiza|analizar|compara|comparar|ventajas y desventajas|estrategia|analise|analisar|vantagens e desvantagens)\b/ },
  { intent: 'reasoning', weight: 3, pattern: /\d\s*[-+*/^=×÷]\s*\d/ },

  // ---- writing ----
  { intent: 'writing', weight: 5, pattern: /\b(?:write|draft|rewrite|compose|essay|email|e-mail|letter|blog post|article|story|poem|lyrics|script|caption|slogan|tagline|cover letter|resume|summari[sz]e|summary|proofread|paraphrase|escribe|escribir|redacta|redactar|reescribe|ensayo|correo|carta|articulo|cuento|historia|poema|guion|resumen|resume esto|resumir|escreva|escrever|redija|redigir|reescreva|ensaio|artigo|conto|resumo)\b/ },
];

/** Follow-ups that tweak the previous image: "make it blue", "another one". */
const IMAGE_FOLLOW_UP = /\b(?:make it|make them|change|add|remove|another|again|more|less|darker|brighter|bigger|smaller|in the style of|version|variation|hazlo|hazla|cambia|agrega|anade|quita|otra|otro|mas|menos|version|faca|mude|adicione|remova|outra|outro|mais)\b/;

/** Words that turn a would-be image request into a code question ("create an image tag in HTML"). */
const IMAGE_CODE_CONTEXT = /\b(?:html|css|tag|element|component|src|svg|canvas|upload|api|endpoint|base64|resize|python|javascript|typescript|react|code|codigo)\b|<img/;

const LANGUAGE_CODES: Record<string, string> = {
  english: 'en', ingles: 'en',
  spanish: 'es', espanol: 'es', castellano: 'es', espanhol: 'es',
  french: 'fr', frances: 'fr',
  german: 'de', aleman: 'de', alemao: 'de',
  italian: 'it', italiano: 'it',
  portuguese: 'pt', portugues: 'pt',
  chinese: 'zh', chino: 'zh', chines: 'zh',
  japanese: 'ja', japones: 'ja',
  korean: 'ko', coreano: 'ko',
  arabic: 'ar', arabe: 'ar',
  russian: 'ru', ruso: 'ru',
  hindi: 'hi',
};

/** Lower-case and strip diacritics so patterns can be written accent-free. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function detectTargetLanguage(folded: string): string | undefined {
  const m = /\b(?:in|into|to|al|en|para o|para a|para)\s+([a-z]+)\b/g;
  let match: RegExpExecArray | null;
  let found: string | undefined;
  // Last mention wins: "translate this Spanish text into English" -> en.
  while ((match = m.exec(folded)) !== null) {
    const code = LANGUAGE_CODES[match[1]];
    if (code) found = code;
  }
  return found;
}

export function classifyIntent(text: string, signals: IntentSignals = {}): IntentResult {
  const raw = text ?? '';
  const folded = foldText(raw).trim();

  // Explicit slash commands are decisive.
  const command = /^\/(image|imagine|img|search|web|translate|code)\b/.exec(folded);
  if (command) {
    const map: Record<string, ElpIntent> = {
      image: 'image_generation', imagine: 'image_generation', img: 'image_generation',
      search: 'web_search', web: 'web_search', translate: 'translation', code: 'code',
    };
    const intent = map[command[1]];
    return {
      intent,
      confidence: 1,
      reason: `command:/${command[1]}`,
      ...(intent === 'translation' ? { targetLanguage: detectTargetLanguage(folded) } : {}),
    };
  }

  if (!folded) {
    return signals.hasImageAttachment
      ? { intent: 'vision', confidence: 0.9, reason: 'attachment:image' }
      : { intent: 'chat', confidence: 0.2, reason: 'empty' };
  }

  const scores = new Map<ElpIntent, number>();
  const hits = new Map<ElpIntent, string>();
  for (const rule of RULES) {
    const match = rule.pattern.exec(folded);
    if (!match) continue;
    scores.set(rule.intent, (scores.get(rule.intent) ?? 0) + rule.weight);
    if (!hits.has(rule.intent)) hits.set(rule.intent, match[0].trim().slice(0, 40));
  }

  // "create an <img> tag", "resize an image in python" — about code, not art.
  if (scores.has('image_generation') && IMAGE_CODE_CONTEXT.test(folded)) {
    scores.set('image_generation', (scores.get('image_generation') ?? 0) - 6);
    scores.set('code', (scores.get('code') ?? 0) + 3);
    if (!hits.has('code')) hits.set('code', 'image+code context');
  }

  // A pasted block to translate often contains code-ish punctuation or dates;
  // an explicit translate verb should still win over those incidental hits.
  if ((scores.get('translation') ?? 0) >= 7) {
    scores.set('translation', (scores.get('translation') ?? 0) + 3);
  }

  // An attached image without a generation request means "look at this".
  if (signals.hasImageAttachment && (scores.get('image_generation') ?? 0) < 6) {
    scores.set('vision', (scores.get('vision') ?? 0) + 6);
    hits.set('vision', 'attachment:image');
  }

  // Short follow-up to an image turn ("make it blue", "otra versión").
  if (
    signals.previousIntent === 'image_generation'
    && folded.length <= 160
    && IMAGE_FOLLOW_UP.test(folded)
    && Math.max(0, ...[...scores.entries()].filter(([k]) => k !== 'image_generation').map(([, v]) => v)) < 6
  ) {
    scores.set('image_generation', Math.max(scores.get('image_generation') ?? 0, 6));
    hits.set('image_generation', 'follow-up to previous image');
  }

  let best: ElpIntent = 'chat';
  let bestScore = 0;
  let total = 0;
  for (const intent of INTENT_PRIORITY) {
    const score = scores.get(intent) ?? 0;
    if (score > 0) total += score;
    if (score > bestScore) {
      best = intent;
      bestScore = score;
    }
  }

  // Weak single signals (a bare year, the word "links") shouldn't hijack a
  // normal conversation: require a minimum score before leaving chat.
  if (bestScore < 3) {
    return { intent: 'chat', confidence: 0.4, reason: 'default' };
  }

  const confidence = Math.min(0.95, 0.5 + (bestScore / Math.max(total, 1)) * 0.3 + Math.min(bestScore, 10) * 0.015);
  const result: IntentResult = {
    intent: best,
    confidence: Math.round(confidence * 100) / 100,
    reason: `keyword:"${hits.get(best) ?? best}"`,
  };
  if (best === 'translation') result.targetLanguage = detectTargetLanguage(folded);
  return result;
}
