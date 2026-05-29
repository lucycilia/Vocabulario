import { useState, useEffect, useCallback, useRef, useMemo, memo, lazy, Suspense, forwardRef, useImperativeHandle } from "react";
import { localDateStr, today, totalForDay, studiedOnDay, FSRS, mergeCards, mergePracticeDays } from "./srs.js";
const RechartsModule = lazy(() =>
  import("recharts").then(mod => ({ default: (props) => props.children(mod) }))
);
// ─── Mobile Detection ───
const useIsMobile = (breakpoint = 600) => {
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
};
// ─── FSRS-5 (Free Spaced Repetition Scheduler) ───
// Based on the open-spaced-repetition project
// DSR model: Difficulty, Stability, Retrievability
// 19 default parameters optimized on millions of reviews
// Default Google Apps Script sync endpoint. Pre-filled so sync works out of the
// box on every device. The Settings input can still override it — a non-empty
// saved value always wins.
const DEFAULT_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby0Iw4rSGwPuqm7IXVF4WIwDw910hdMW2vP-jhXYeEtcSpSTaYJQC2DEk1OVcj7mGE/exec";
// ─── FSRS Preview Intervals ───
const previewIntervals = (card) => {
  const grades = [1, 2, 3, 4];
  const reps = card.reps || 0;
  // A new card not yet in its learning step → every non-Forgot grade leads to a
  // 10-min re-exposure, not the FSRS interval.
  const inLearningStart = reps === 0 && !(card.learningStep || 0);
  return grades.map((grade) => {
    if (grade === 1) return 0; // forgot = 10 min delay, not days
    if (inLearningStart) return 0; // first click goes to 10-min learning step
    let { stability: s, difficulty: d } = card;
    if (reps === 0) {
      s = FSRS.s0(grade);
    } else {
      const lastReviewDate = card.lastReview
        ? new Date(card.lastReview + "T12:00:00")
        : new Date();
      const elapsed = Math.max(0, (new Date() - lastReviewDate) / 86400000);
      const r = FSRS.retrievability(elapsed, s);
      s = FSRS.stability(d, s, r, grade);
    }
    return FSRS.interval(s);
  });
};
const formatFutureDate = (days) => {
  if (days === 0) return "10min";
  const d = new Date();
  d.setDate(d.getDate() + days);
  const dateStr = `${d.getDate()}/${d.getMonth() + 1}`;
  if (days === 1) return "amanha";
  return `${days}d \u00b7 ${dateStr}`;
};
// ─── Text Similarity (Levenshtein) ───
const textSimilarity = (a, b) => {
  const norm = (s) => s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const x = norm(a), y = norm(b);
  if (x === y) return 100;
  if (!x || !y) return 0;
  const m = x.length, n = y.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = x[i - 1] === y[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return Math.round((1 - prev[n] / Math.max(m, n)) * 100);
};
const computeScore = (userAnswer, card, studyDirection) => {
  if (studyDirection === "pt-en") return textSimilarity(userAnswer, card.translation);
  const wordScore = textSimilarity(userAnswer, card.word);
  const phraseScore = card.phrase ? textSimilarity(userAnswer, card.phrase) : 0;
  return Math.max(wordScore, phraseScore);
};
// ─── Brazilian Portuguese TTS ───
const speakPT = (text, onEnd) => {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const ptBR =
    voices.find((v) => v.lang === "pt-BR") ||
    voices.find((v) => v.lang.startsWith("pt"));
  if (ptBR) utter.voice = ptBR;
  utter.lang = "pt-BR";
  utter.rate = 0.88;
  if (onEnd) { utter.onend = onEnd; utter.onerror = onEnd; }
  return window.speechSynthesis.speak(utter);
};
const stopPT = () => {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
};
// ─── Memory Stages ───
const getStage = (card) => {
  if (!card || card.reps === 0) return "new";
  const s = card.stability || 0;
  if (s < 3) return "learning";
  if (s < 21) return "young";
  if (s < 90) return "mature";
  return "mastered";
};
const stageColors = {
  new: { bg: "rgba(160,160,160,0.1)", text: "#8C8C8C", darkText: "#A0A0A0" },
  learning: { bg: "rgba(59,130,246,0.1)", text: "#3B82F6", darkText: "#60A5FA" },
  young: { bg: "rgba(245,158,11,0.1)", text: "#D97706", darkText: "#FBBF24" },
  mature: { bg: "rgba(45,106,79,0.1)", text: "#2D6A4F", darkText: "#6FCF97" },
  mastered: { bg: "rgba(139,92,246,0.1)", text: "#7C3AED", darkText: "#A78BFA" },
  suspended: { bg: "rgba(120,120,120,0.12)", text: "#707070", darkText: "#909090" },
};
const stageLabel = (stage) => {
  const map = { new: "stageNew", learning: "stageLearning", young: "stageYoung", mature: "stageMature", mastered: "stageMastered", suspended: "stageSuspended" };
  return t[map[stage]] || stage;
};
// ─── Import Parsers ───
// Function words that strongly indicate one language. Ambiguous words ("a", "no", "as")
// are intentionally excluded to avoid double-counting against the other language.
const PT_WORDS = new Set([
  "que","não","para","com","está","são","tem","uma","isso","mais","também",
  "porque","quando","muito","sempre","pelo","pela","do","da","dos","das",
  "em","ele","ela","um","os","meu","minha","seu","sua","foi","ser","vai",
  "vou","quer","mas","se","até","depois","antes","aqui","ali","também",
]);
const EN_WORDS = new Set([
  "the","and","of","to","in","is","are","was","were","be","been","have",
  "has","had","this","that","they","them","with","for","you","your",
  "what","when","my","we","our","it","its","he","she","his","her",
  "at","on","by","from","will","would","can","could",
]);
// Score how Portuguese a text looks. Positive = leans PT, negative = leans EN.
// Used to compare two sides of a card and decide which is which.
const ptScore = (text) => {
  if (!text) return 0;
  let score = 0;
  // Diacritics: strongest signal — Portuguese-specific accented characters.
  const diacritics = (text.match(/[ãõçêéáíóúâô]/gi) || []).length;
  score += diacritics * 3;
  // Word-level signals.
  const words = text.toLowerCase().match(/\b[\wàâãäåçèéêëìíîïñòóôõöùúûüý']+\b/g) || [];
  for (const w of words) {
    if (PT_WORDS.has(w)) score += 1;
    if (EN_WORDS.has(w)) score -= 1;
  }
  // Distinctive Portuguese bigrams/trigrams.
  if (/ção|ções|ões/i.test(text)) score += 3;
  else if (/lh|nh/i.test(text)) score += 1;
  return score;
};
// Backwards-compat alias for code paths that just want a yes/no.
const looksPortuguese = (text) => ptScore(text) > 0;
const parseImportLine = (line) => {
  line = line.trim();
  if (!line || line.startsWith("#") || line.startsWith("//")) return null;
  line = line.replace(/^[\-\*•]\s+/, "").replace(/^\d+[\.\)]\s+/, "").trim();
  if (!line) return null;
  let parts = null;
  if (line.includes("↔")) {
    parts = line.split("↔").map(s => s.trim());
  } else if (line.includes("<>")) {
    parts = line.split("<>").map(s => s.trim());
  } else if (line.includes(" == ")) {
    parts = line.split(" == ").map(s => s.trim());
  } else if (line.includes(" >> ")) {
    parts = line.split(" >> ").map(s => s.trim());
  } else if (line.includes("\t")) {
    parts = line.split("\t").map(s => s.trim());
  } else if (line.includes(" | ")) {
    parts = line.split(" | ").map(s => s.trim());
  } else if (line.includes(",")) {
    parts = line.split(",").map(s => s.trim());
  } else if (line.includes(";")) {
    parts = line.split(";").map(s => s.trim());
  }
  if (!parts || parts.length < 2) return null;
  let ptSide = parts[0].trim();
  let enSide = parts.slice(1).join(", ").trim();
  // Compare the two sides — whichever scores higher as Portuguese is treated as PT.
  // Tie or both zero: preserve original order.
  if (ptScore(enSide) > ptScore(ptSide)) {
    [ptSide, enSide] = [enSide, ptSide];
  }
  if (!ptSide || !enSide) return null;
  const cleanEn = enSide.replace(/\*\*/g, "").trim();
  const boldMatch = ptSide.match(/\*\*(.+?)\*\*/);
  if (boldMatch) {
    const plainPhrase = ptSide.replace(/\*\*/g, "");
    const keyword = boldMatch[1];
    const beforeBold = ptSide.substring(0, ptSide.indexOf("**"));
    const realStart = beforeBold.length;
    const realEnd = realStart + keyword.length;
    return {
      word: keyword,
      translation: cleanEn,
      phrase: plainPhrase,
      keywordStart: realStart,
      keywordEnd: realEnd,
    };
  }
  return {
    word: ptSide,
    translation: cleanEn,
    phrase: "",
    keywordStart: 0,
    keywordEnd: 0,
  };
};
const parseImportText = (text) => {
  const lines = text.split("\n");
  const results = [];
  const errors = [];
  let startIdx = 0;
  if (lines.length > 1) {
    const first = lines[0].toLowerCase().trim();
    const headerWords = ["português", "portuguese", "english", "phrase", "word", "front", "back", "palavra", "tradução", "translation"];
    const cells = first.split(/[,;\t|↔<>]|==|>>/).map(s => s.trim()).filter(Boolean);
    const isHeader = cells.length >= 2 && cells.every(c => c.split(/\s+/).length <= 3) && cells.some(c => headerWords.includes(c));
    if (isHeader) {
      startIdx = 1;
    }
  }
  for (let i = startIdx; i < lines.length; i++) {
    const parsed = parseImportLine(lines[i]);
    if (parsed) results.push({ ...parsed, _srcLine: lines[i].trim() });
    else if (lines[i].trim()) errors.push({ line: i + 1, text: lines[i].trim() });
  }
  return { results, errors };
};
// ─── RemNote Last Practiced Dates ───
const REMNOTE_LAST_PRACTICED = [
  // Solidifying — from Feb 07, 2026 batch
  {"text": "He asked about your new proposal.", "lastPracticed": "2026-02-07"},
  {"text": "Companies should avoid dark patterns that deceive users", "lastPracticed": "2026-02-07"},
  {"text": "It's no use crying over spilled milk", "lastPracticed": "2026-02-07"},
  {"text": "If it tastes like X, I won't like it", "lastPracticed": "2026-02-07"},
  {"text": "Who gives a crap about that?", "lastPracticed": "2026-02-07"},
  {"text": "I've been climbing on and off for a few years.", "lastPracticed": "2026-02-07"},
  {"text": "É fundamental reduzir a carga cognitiva do usuário em cada etapa do processo", "lastPracticed": "2026-02-07"},
  {"text": "A floresta parecia calma durante o dia, mas à noite se tornava assustadora, cheia de sons estranhos.", "lastPracticed": "2026-02-07"},
  {"text": "I love languages; for me, I'm decoding the world around me.", "lastPracticed": "2026-02-07"},
  {"text": "Let's go to the beach, whether it rains or is sunny", "lastPracticed": "2026-02-07"},
  {"text": "Quem quer que ligue, diga que eu não estou", "lastPracticed": "2026-02-07"},
  {"text": "He's a bit controlling with money", "lastPracticed": "2026-02-07"},
  {"text": "That science fiction movie was more my vibe", "lastPracticed": "2026-02-07"},
  {"text": "When I realized I almost missed the flight, I thought: \"What a mess it could have been\"", "lastPracticed": "2026-02-07"},
  {"text": "No decorrer do ano, vamos revisar os resultados trimestralmente.", "lastPracticed": "2026-02-07"},
  {"text": "o locador | o proprietário", "lastPracticed": "2026-02-07"},
  {"text": "As roupas novas tinham várias manchas de tinta após a reforma.", "lastPracticed": "2026-01-20"},
  {"text": "My nephew fell and now he is toothless.", "lastPracticed": "2026-01-20"},
  {"text": "Is it her? In the flesh", "lastPracticed": "2026-01-20"},
  {"text": "He is preparing for the university entrance exam and is attending an intensive preparatory course on weekends", "lastPracticed": "2026-01-20"},
  {"text": "Wherever they go, they're hailed", "lastPracticed": "2026-01-19"},
  {"text": "Relax, I'm kidding, don't take it seriously!", "lastPracticed": "2026-01-19"},
  {"text": "Everyone feels comfortable here. (two words, not \"tudo mundo\")", "lastPracticed": "2026-01-19"},
  {"text": "We like to bake sourdough bread at home using my dad's recipe from Malta", "lastPracticed": "2026-01-19"},
  {"text": "do you know how to take care of plants?", "lastPracticed": "2026-01-19"},
  {"text": "That technology is light-years ahead of the competition.", "lastPracticed": "2026-01-19"},
  {"text": "Ela sempre usa um rabo de cavalo pra malhar", "lastPracticed": "2026-01-19"},
  {"text": "we need to look for a quick solution", "lastPracticed": "2026-01-19"},
  {"text": "He's still looking for work", "lastPracticed": "2026-01-19"},
  {"text": "I came out at 16", "lastPracticed": "2026-01-08"},
  {"text": "Eu tenho escalado de vez em quando há alguns anos.", "lastPracticed": "2025-12-31"},
  {"text": "É normal que haja diferenças culturais.", "lastPracticed": "2025-12-27"},
  {"text": "O aumento de temperatura tem causado os chamados eventos extremos, como tempestades severas.", "lastPracticed": "2025-12-26"},
  {"text": "To scratch the car's paint", "lastPracticed": "2025-12-26"},
  {"text": "To erase the board", "lastPracticed": "2025-12-26"},
  {"text": "My neighborhood went through a process of gentrification in recent years", "lastPracticed": "2025-12-15"},
  {"text": "Eu amo línguas; para mim, estou decodificando o mundo ao meu redor", "lastPracticed": "2025-12-12"},
  {"text": "A apneia do sono é hereditária em minha família", "lastPracticed": "2025-12-11"},
  {"text": "The new tenant will only receive the keys on the contract's effective date", "lastPracticed": "2025-12-01"},
  // Retaining
  {"text": "O autismo é considerado um transtorno do espectro", "lastPracticed": "2026-02-07"},
  {"text": "Deslizar no gelo", "lastPracticed": "2026-02-07"},
  {"text": "An eraser", "lastPracticed": "2026-02-07"},
  {"text": "Era para ele ter embarcado há duas horas, mas seu voo foi cancelado", "lastPracticed": "2026-02-07"},
  {"text": "Pelo que eu saiba, a reunião está marcada para amanhã de manhã", "lastPracticed": "2026-02-07"},
  {"text": "The car skidded on the wet road/lane", "lastPracticed": "2026-02-07"},
  {"text": "Quer saiba a resposta quer não, tem que esperar a sua vez", "lastPracticed": "2026-02-07"},
  {"text": "The nurses were on the front line during the pandemic", "lastPracticed": "2026-02-07"},
  {"text": "Ele ainda está procurando trabalho", "lastPracticed": "2026-02-07"},
  {"text": "É necessário que ela aprenda uma língua.", "lastPracticed": "2026-02-07"},
  {"text": "If I'm not wrong, she departs tomorrow morning", "lastPracticed": "2026-01-19"},
  {"text": "Eles instalaram uma rampa de acesso para cadeirantes", "lastPracticed": "2026-01-05"},
  {"text": "Now that the company is doing well, we can expand.", "lastPracticed": "2026-01-05"},
  {"text": "It is essential to reduce the user's cognitive load at each stage of the process", "lastPracticed": "2026-01-05"},
  {"text": "O oftalmologista me deu uma receita de óculos depois do exame", "lastPracticed": "2026-01-05"},
  {"text": "Não é verdade que ela mente o tempo todo.", "lastPracticed": "2026-01-01"},
  {"text": "To erase the past/move on", "lastPracticed": "2025-12-31"},
  {"text": "É possível que hoje ainda chova", "lastPracticed": "2025-12-27"},
  {"text": "Na pesquisa, utilizamos a classificação de cartões para entender os modelos mentais dos usuários", "lastPracticed": "2025-12-27"},
  {"text": "Para onde quer que vá, sempre se divertem à beça", "lastPracticed": "2025-12-26"},
  {"text": "Por onde quer que passem, são aclamados", "lastPracticed": "2025-12-26"},
  {"text": "É melhor que você consulte um médico.", "lastPracticed": "2025-12-26"},
  {"text": "After reading the summary, I understood the premise of the book immediately", "lastPracticed": "2025-12-26"},
  {"text": "Where's the screwdriver?", "lastPracticed": "2025-12-26"},
  {"text": "This topic is self-explanatory and requires no further explanation", "lastPracticed": "2025-12-26"},
  {"text": "Daria tudo para não ter prova amanhã", "lastPracticed": "2025-12-23"},
  {"text": "Este tópico é autoexplicativo e não requer mais explicações", "lastPracticed": "2025-12-23"},
  {"text": "Male cats are more cuddly and affectionate than female cats, who are generally more independent", "lastPracticed": "2025-12-15"},
  {"text": "To change the windshield wiper rubber", "lastPracticed": "2025-12-13"},
  {"text": "Tendo em mente as limitações de tempo, precisamos ajustar o cronograma", "lastPracticed": "2025-12-12"},
  {"text": "I need to schedule an appointment with the ophthalmologist to check my vision", "lastPracticed": "2025-12-12"},
  {"text": "A Ana não vem trabalhar. Tem estado doente", "lastPracticed": "2025-12-12"},
  {"text": "Preciso marcar uma consulta com o oftalmologista para checar minha visão", "lastPracticed": "2025-12-12"},
  {"text": "I need to cross this item off the list", "lastPracticed": "2025-12-12"},
  {"text": "Os gatos machos são mais fofos e carinhosos do que as gatas fêmeas, que geralmente são mais independentes", "lastPracticed": "2025-12-12"},
  {"text": "É aconselhável que vocês descansem todos os dias.", "lastPracticed": "2025-12-11"},
  {"text": "Cadê a chave de fenda?", "lastPracticed": "2025-12-11"},
  {"text": "To turn off the lights", "lastPracticed": "2025-12-11"},
  {"text": "Preciso riscar esse item da lista", "lastPracticed": "2025-12-11"},
  {"text": "The ophthalmologist gave me a glasses prescription after the exam", "lastPracticed": "2025-12-11"},
  {"text": "Aprender um novo idioma é como decodificar um código secreto", "lastPracticed": "2025-12-11"},
  {"text": "Para-brisa", "lastPracticed": "2025-12-11"},
  {"text": "O tempo tem estado ótimo", "lastPracticed": "2025-12-02"},
  {"text": "It's not true that she lies all the time.", "lastPracticed": "2025-12-02"},
  {"text": "É uma pena que eles não possam vir.", "lastPracticed": "2025-12-02"},
  {"text": "Ao comprar a TV, verifique o tamanho da tela em polegadas, pois é assim que os fabricantes listam", "lastPracticed": "2025-12-02"},
  {"text": "To blow out the candle", "lastPracticed": "2025-12-01"},
  {"text": "Riscar", "lastPracticed": "2025-12-01"},
  {"text": "To use an eraser to fix a mistake", "lastPracticed": "2025-12-01"},
  {"text": "Você sabe cuidar de plantas?", "lastPracticed": "2025-12-01"},
  {"text": "To swipe your finger on the phone screen", "lastPracticed": "2025-12-01"},
  {"text": "Apagar a vela", "lastPracticed": "2025-12-01"},
  {"text": "To erase from memory", "lastPracticed": "2025-12-01"},
  {"text": "She always knew that one day she would open her own business.", "lastPracticed": "2025-12-01"},
  {"text": "This chair is wobbly, it needs a screw", "lastPracticed": "2025-12-01"},
  {"text": "Trocar a borracha do para-brisa", "lastPracticed": "2025-12-01"},
  {"text": "To turn on the windshield wipers in the rain", "lastPracticed": "2025-12-01"},
  {"text": "Windscreen wiper", "lastPracticed": "2025-12-01"},
  {"text": "Ana is not coming to work. She's been ill", "lastPracticed": "2025-12-01"},
  {"text": "Riscar um nome da lista", "lastPracticed": "2025-12-01"},
  {"text": "To scratch out", "lastPracticed": "2025-12-01"},
  {"text": "The weather has been great", "lastPracticed": "2025-12-01"},
  {"text": "Na rodovia, pagamos pedágio", "lastPracticed": "2025-12-01"},
  {"text": "Mergulhar em um livro", "lastPracticed": "2025-12-01"},
  {"text": "No show de stand-up, o comediante matou a pau.", "lastPracticed": "2025-12-01"},
  {"text": "Os enfermeiros estavam na linha de frente durante a pandemia", "lastPracticed": "2025-12-01"},
  {"text": "Learning a new language is like decoding a secret code", "lastPracticed": "2025-12-01"},
  {"text": "O comediante deixou a plateia em êxtase.", "lastPracticed": "2025-12-01"},
  {"text": "At the stand-up show, the comedian nailed it.", "lastPracticed": "2025-12-01"},
  {"text": "Passar a borracha no passado", "lastPracticed": "2025-10-30"},
  {"text": "Apagar o quadro", "lastPracticed": "2025-10-30"},
  {"text": "To dive headfirst into a project", "lastPracticed": "2025-10-30"},
  {"text": "Mergulhar no trabalho", "lastPracticed": "2025-10-30"},
  {"text": "To scratch the surface of something", "lastPracticed": "2025-10-30"},
  {"text": "Deslizar o dedo na tela do celular", "lastPracticed": "2025-10-30"},
  {"text": "Arranhar", "lastPracticed": "2025-10-30"},
  {"text": "Mergulhar no mar", "lastPracticed": "2025-10-30"},
  {"text": "Minha avó aprendeu a costurar belos vestidos à mão", "lastPracticed": "2025-10-30"},
  {"text": "As far as I know, no one was informed about the change", "lastPracticed": "2025-10-30"},
  {"text": "Meu sobrinho caiu e agora está banguelo.", "lastPracticed": "2025-10-30"},
  {"text": "They installed an access ramp for wheelchair users", "lastPracticed": "2025-10-30"},
  {"text": "How about a coffee before the meeting?", "lastPracticed": "2025-10-30"},
  {"text": "O lançamento do aplicativo caiu de maduro depois de tanto esforço da equipe.", "lastPracticed": "2025-10-05"},
  {"text": "I'd give anything to not have a test tomorrow", "lastPracticed": "2025-10-05"},
  {"text": "Até onde eu sei, ninguém foi informado sobre a mudança.", "lastPracticed": "2025-10-05"},
  {"text": "Ele arranhou um pouco de inglês na viagem", "lastPracticed": "2025-10-05"},
  {"text": "Essa cadeira está solta, precisa de um parafuso", "lastPracticed": "2025-09-16"},
  {"text": "To dip the brush in paint", "lastPracticed": "2025-09-16"},
  {"text": "To cross out a name from the list", "lastPracticed": "2025-08-18"},
  {"text": "Usar a borracha para apagar um erro", "lastPracticed": "2025-08-18"},
  {"text": "Makeup brush", "lastPracticed": "2025-08-18"},
  {"text": "Ligar o limpador de para-brisa na chuva", "lastPracticed": "2025-08-18"},
  {"text": "To dive (Scooba diving)", "lastPracticed": "2025-08-18"},
  {"text": "Meu gato me arranhou", "lastPracticed": "2025-08-18"},
  {"text": "Riscar o chão com giz", "lastPracticed": "2025-08-18"},
  {"text": "To use a fine brush to paint details", "lastPracticed": "2025-08-18"},
  {"text": "Apagar da memória", "lastPracticed": "2025-08-18"},
  {"text": "Mergulhar de cabeça em um projeto", "lastPracticed": "2025-08-18"},
  {"text": "Pincel", "lastPracticed": "2025-08-18"},
  {"text": "Arranhar a superfície de algo", "lastPracticed": "2025-08-05"},
  {"text": "Deslizar", "lastPracticed": "2025-08-05"},
  {"text": "Arranhar a pintura do carro", "lastPracticed": "2025-08-05"},
  {"text": "To dive into the sea", "lastPracticed": "2025-08-05"},
  {"text": "To scratch", "lastPracticed": "2025-08-05"},
  {"text": "My cat scratched me", "lastPracticed": "2025-08-05"},
  {"text": "A paint brush", "lastPracticed": "2025-08-05"},
  {"text": "Apagar as luzes", "lastPracticed": "2025-08-05"},
  {"text": "Mergulhar o pincel na tinta", "lastPracticed": "2025-08-05"},
  {"text": "Usar um pincel fino para pintar detalhes", "lastPracticed": "2025-08-05"},
  {"text": "Ele está se preparando para o vestibular e faz um cursinho intensivo aos finais de semana", "lastPracticed": "2025-07-21"},
  {"text": "He spoke (barely) some English on the trip.", "lastPracticed": "2025-07-21"},
  {"text": "Apagar", "lastPracticed": "2025-07-21"},
  {"text": "To swipe", "lastPracticed": "2025-07-21"},
  {"text": "To get deeply into a book", "lastPracticed": "2025-07-21"},
  {"text": "Pincel de maquiagem", "lastPracticed": "2025-07-21"},
  {"text": "To draw a line on the ground with chalk", "lastPracticed": "2025-07-21"},
  {"text": "Mergulhar", "lastPracticed": "2025-07-21"},
  {"text": "To immerse oneself in work", "lastPracticed": "2025-07-21"},
  {"text": "O carro deslizou na pista molhada –", "lastPracticed": "2025-07-21"},
  {"text": "To dive into the swimming pool", "lastPracticed": "2025-07-21"},
  {"text": "To slide on the ice", "lastPracticed": "2025-07-20"},
  {"text": "To erase", "lastPracticed": "2025-07-20"},
  {"text": "Mergulhar na piscina", "lastPracticed": "2025-07-20"},
  // Stale
  {"text": "If I'm not mistaken, the restaurant closes at ten (formal)", "lastPracticed": "2026-02-07"},
  {"text": "The app launch was bound to happen after so much effort from the team.", "lastPracticed": "2026-02-07"},
  {"text": "Throughout the year, we will review the results quarterly.", "lastPracticed": "2026-01-20"},
  {"text": "O software apresentou uma trava inesperada durante a atualização", "lastPracticed": "2026-01-08"},
  {"text": "Sleep apnea is hereditary in my family.", "lastPracticed": "2026-01-08"},
  {"text": "It's likely that he will be late.", "lastPracticed": "2026-01-07"},
  {"text": "Autism is considered a spectrum disorder", "lastPracticed": "2026-01-07"},
  {"text": "Last time we visited, we barely saw any toucans in the reserve", "lastPracticed": "2026-01-07"},
  {"text": "Todo motorista deve verificar os seus pontos", "lastPracticed": "2026-01-07"},
  {"text": "Quando ela reclama sem motivo, isso me tira do sério", "lastPracticed": "2026-01-07"},
  {"text": "The software froze unexpectedly during the update (Block / Lock / Jam, depends on context)", "lastPracticed": "2026-01-06"},
  {"text": "It's clear that they need help with so much work.", "lastPracticed": "2026-01-06"},
  {"text": "It's useful that you review the material before the exam.", "lastPracticed": "2026-01-06"},
  {"text": "Quaisquer que sejam as dificuldades, temos que enfrentá-las", "lastPracticed": "2026-01-06"},
  {"text": "It's easy for you (both) to understand the explanation with this example.", "lastPracticed": "2026-01-06"},
  {"text": "your property may be rented with QuintoAndar or with an estate agent.", "lastPracticed": "2026-01-06"},
  {"text": "Regarding the budget, we need to cut expenses. (Very formal)", "lastPracticed": "2026-01-06"},
  {"text": "she's been looking for a job for months (coloquial present perfect continuous)", "lastPracticed": "2026-01-06"},
  {"text": "The steep roads of Ouro Preto are a challenge for tourists", "lastPracticed": "2026-01-05"},
  {"text": "When she complains for no reason, it drives me crazy (gets on my nerves)", "lastPracticed": "2026-01-05"},
  {"text": "You are the woman that I've always dreamed of meeting", "lastPracticed": "2026-01-05"},
  {"text": "Since the first meeting, we've (casual) gotten along well and worked in sync.", "lastPracticed": "2026-01-05"},
  {"text": "They discovered a hidden passage behind the bookshelf", "lastPracticed": "2026-01-05"},
  {"text": "The public program aims to teach literacy to adults who didn't have the opportunity to study (To teach literacy / To make literate)", "lastPracticed": "2026-01-05"},
  {"text": "O atleta usou uma bandagem para proteger o ferimento no joelho", "lastPracticed": "2026-01-05"},
  {"text": "It's necessary that you (plural) finish this service soon.", "lastPracticed": "2026-01-05"},
  {"text": "É bom que vocês cheguem na hora certa.", "lastPracticed": "2026-01-04"},
  {"text": "É justo que ele receba o prêmio.", "lastPracticed": "2026-01-04"},
  {"text": "E ela? A própria", "lastPracticed": "2026-01-04"},
  {"text": "It is important to store the documents in a secure place", "lastPracticed": "2026-01-04"},
  {"text": "(Refogar) Para a sopa, refogue cebola picada em manteiga antes de adicionar os legumes", "lastPracticed": "2026-01-04"},
  {"text": "We slept in a bunk bed when we went camping", "lastPracticed": "2026-01-04"},
  {"text": "In the research, we used card sorting to understand the users' mental models.", "lastPracticed": "2026-01-04"},
  {"text": "Now, more than ever, we need to act responsibly", "lastPracticed": "2026-01-04"},
  {"text": "A gente precisa procurar uma solução rápida", "lastPracticed": "2026-01-03"},
  {"text": "Agora que a empresa está bem das pernas, podemos expandir.", "lastPracticed": "2026-01-03"},
  {"text": "Tendo em mente o prazo apertado, precisamos trabalhar rápido.", "lastPracticed": "2026-01-03"},
  {"text": "O novo inquilino vai receber as chaves apenas no dia da vigência do contrato", "lastPracticed": "2026-01-03"},
  {"text": "Ele perguntou a respeito de sua nova proposta.", "lastPracticed": "2026-01-03"},
  {"text": "Use the squeegee to get the water off the floor", "lastPracticed": "2026-01-03"},
  {"text": "Wherever they go, they always have a blast", "lastPracticed": "2026-01-02"},
  {"text": "It's jaw-dropping", "lastPracticed": "2026-01-02"},
  {"text": "É preciso que vocês acabem logo esse serviço.", "lastPracticed": "2026-01-01"},
  {"text": "Keeping in mind the time constraints, we need to adjust the schedule", "lastPracticed": "2026-01-01"},
  {"text": "My grandmother learned to sew beautiful dresses by hand", "lastPracticed": "2025-12-31"},
  {"text": "She went to look for the information on the official site", "lastPracticed": "2025-12-31"},
  {"text": "Stop being a pussy and just talk to her", "lastPracticed": "2025-12-31"},
  {"text": "The temperature rise has caused the so-called extreme events, like severe storms.", "lastPracticed": "2025-12-31"},
  {"text": "É importante armazenar os documentos em um local seguro", "lastPracticed": "2025-12-31"},
  {"text": "Matar dois coelhos com uma cajadada só", "lastPracticed": "2025-12-31"},
  {"text": "É de cair o queixo", "lastPracticed": "2025-12-31"},
  {"text": "We didn't have a nail to hang the picture.", "lastPracticed": "2025-12-31"},
  {"text": "Vocês têm que pagar, quer queiram quer não, caso contrário, chamamos a polícia", "lastPracticed": "2025-12-31"},
  {"text": "O que quer que diga, já ninguém acredita nele", "lastPracticed": "2025-12-31"},
  {"text": "When buying a TV, check the screen size in inches, as that is how manufacturers list it", "lastPracticed": "2025-12-23"},
  {"text": "Não adianta chorar pelo leite derramado", "lastPracticed": "2025-12-23"},
  {"text": "Por onde quer que venha, vão pegar um trânsito daqueles", "lastPracticed": "2025-12-12"},
  {"text": "Ele faz o que quer que seja para subir na vida", "lastPracticed": "2025-12-11"},
];
// Number of cards last practiced on each date, tallied from the RemNote import.
// Used to backfill day-counts that were imported without a per-day count.
const remnotePracticeDayTally = () => {
  const counts = {};
  for (const e of REMNOTE_LAST_PRACTICED) {
    if (e && e.lastPracticed) counts[e.lastPracticed] = (counts[e.lastPracticed] || 0) + 1;
  }
  return counts;
};
// Stable per-device id, used to shard daily review counts so two devices can
// study on the same day without one overwriting the other's count.
const getDeviceId = () => {
  try {
    let id = localStorage.getItem("vocab-device-id");
    if (!id) {
      const rand = (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      id = `dev_${rand}`;
      localStorage.setItem("vocab-device-id", id);
    }
    return id;
  } catch {
    return "dev_anon";
  }
};
// ─── Study Timer Helpers ───
const IDLE_CAP_MS = 2 * 60 * 60 * 1000; // 2-hour auto-stop after gap
const HEARTBEAT_MS = 30 * 1000;
const formatDuration = (totalSec, opts = {}) => {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (opts.short) {
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${sec}s`;
  }
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
};
// Compact "Xh Ym" / "Xh" / "Ym" / "0m" for editable inputs
const formatTimeInput = (totalSec) => {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0 && m === 0) return "0m";
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};
// Parse "1h 30m", "1h30m", "90m", "1.5h", "90" -> seconds. null = invalid.
const parseTimeInput = (raw) => {
  if (typeof raw !== "string") return null;
  const str = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!str) return 0;
  if (/^\d+(\.\d+)?$/.test(str)) {
    return Math.round(parseFloat(str) * 60);
  }
  let hours = 0;
  let mins = 0;
  let matched = false;
  const hMatch = str.match(/(\d+(?:\.\d+)?)h/);
  const mMatch = str.match(/(\d+(?:\.\d+)?)m/);
  if (hMatch) { hours = parseFloat(hMatch[1]); matched = true; }
  if (mMatch) { mins = parseFloat(mMatch[1]); matched = true; }
  if (!matched) return null;
  return Math.round(hours * 3600 + mins * 60);
};
// Manual locale-safe short date: "Tue, 26 May" or "Tue, 26 May 2024"
const formatLogDate = (dateStr, lang) => {
  const d = new Date(dateStr + "T12:00:00");
  if (isNaN(d.getTime())) return dateStr;
  const enDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const enMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ptDays = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  const ptMonths = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const useEN = lang === "en";
  const dayName = (useEN ? enDays : ptDays)[d.getDay()];
  const monthName = (useEN ? enMonths : ptMonths)[d.getMonth()];
  const yearNow = new Date().getFullYear();
  const y = d.getFullYear();
  const yearPart = y === yearNow ? "" : ` ${y}`;
  return `${dayName}, ${d.getDate()} ${monthName}${yearPart}`;
};
const isoWeek = (d) => {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  // Thursday in current week decides the year
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const week1 = new Date(t.getFullYear(), 0, 4);
  return {
    year: t.getFullYear(),
    week: 1 + Math.round(((t - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7),
  };
};
const weekStartStr = (d) => {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  const dow = (t.getDay() + 6) % 7; // 0 = Monday
  t.setDate(t.getDate() - dow);
  return localDateStr(t);
};
const aggregateStudyTime = (studyTime, period, range) => {
  // returns [{ key, label, seconds, startDate }, ...] ordered chronologically
  const now = new Date();
  const buckets = new Map();
  if (period === "day") {
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = localDateStr(d);
      buckets.set(key, { key, label: `${d.getMonth() + 1}/${d.getDate()}`, seconds: 0, startDate: key });
    }
    Object.entries(studyTime).forEach(([date, sec]) => {
      if (buckets.has(date)) buckets.get(date).seconds += sec;
    });
  } else if (period === "week") {
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i * 7);
      const key = weekStartStr(d);
      if (!buckets.has(key)) {
        const ws = new Date(key + "T12:00:00");
        buckets.set(key, { key, label: `${ws.getMonth() + 1}/${ws.getDate()}`, seconds: 0, startDate: key });
      }
    }
    Object.entries(studyTime).forEach(([date, sec]) => {
      const wk = weekStartStr(new Date(date + "T12:00:00"));
      if (buckets.has(wk)) buckets.get(wk).seconds += sec;
    });
  } else if (period === "month") {
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      buckets.set(key, { key, label: monthNames[d.getMonth()], seconds: 0, startDate: key + "-01" });
    }
    Object.entries(studyTime).forEach(([date, sec]) => {
      const k = date.slice(0, 7);
      if (buckets.has(k)) buckets.get(k).seconds += sec;
    });
  } else if (period === "year") {
    for (let i = range - 1; i >= 0; i--) {
      const y = now.getFullYear() - i;
      const key = String(y);
      buckets.set(key, { key, label: key, seconds: 0, startDate: key + "-01-01" });
    }
    Object.entries(studyTime).forEach(([date, sec]) => {
      const k = date.slice(0, 4);
      if (buckets.has(k)) buckets.get(k).seconds += sec;
    });
  }
  return Array.from(buckets.values());
};
const normalizeDate = (v) => {
  if (!v) return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return localDateStr(d);
  return "";
};
const getDaysInYear = (year) => {
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(localDateStr(new Date(d)));
  }
  return days;
};
const getWeekday = (dateStr) => new Date(dateStr + "T12:00:00").getDay();
const getMonth = (dateStr) => new Date(dateStr + "T12:00:00").getMonth();
const MONTH_LABELS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
// ─── Design Tokens (theme-aware) ───
const themes = {
  light: {
    bg: "#F5F5F5",
    bgCard: "#FFFFFF",
    bgCardHover: "#EFEFEF",
    bgInput: "#EFEFEF",
    border: "rgba(0,0,0,0.08)",
    borderStrong: "rgba(0,0,0,0.14)",
    text: "#1A1A1A",
    textSecondary: "#555555",
    textTertiary: "#888888",
    textPlaceholder: "#BBBBBB",
    accent: "#1A1A1A",
    accentSoft: "rgba(26,26,26,0.06)",
    keyword: "#2F6296",
    keywordBg: "rgba(47,98,150,0.10)",
    success: "#2D6A4F",
    danger: "#C4483E",
    dangerBg: "rgba(196,72,62,0.06)",
    warning: "#B5860B",
    warningBg: "rgba(181,134,11,0.06)",
    shadow: "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02)",
    shadowLg: "0 4px 20px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)",
    radius: 16,
    radiusSm: 12,
    radiusPill: 9999,
    heatEmpty: "#E8E8E8",
    heat1: "#B7DFBA",
    heat2: "#5A9E6F",
    heat3: "#2D6A4F",
  },
  dark: {
    bg: "#0E0E0E",
    bgCard: "#1A1A1A",
    bgCardHover: "#232323",
    bgInput: "#232323",
    border: "rgba(255,255,255,0.10)",
    borderStrong: "rgba(255,255,255,0.20)",
    text: "#F0F0F0",
    textSecondary: "#B0B0B0",
    textTertiary: "#808080",
    textPlaceholder: "#505050",
    accent: "#F0F0F0",
    accentSoft: "rgba(255,255,255,0.08)",
    keyword: "#7CB0E0",
    keywordBg: "rgba(124,176,224,0.14)",
    success: "#6FCF97",
    danger: "#F28B82",
    dangerBg: "rgba(242,139,130,0.1)",
    warning: "#F5C563",
    warningBg: "rgba(245,197,99,0.1)",
    shadow: "0 1px 4px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)",
    shadowLg: "0 4px 24px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.3)",
    radius: 16,
    radiusSm: 12,
    radiusPill: 9999,
    heatEmpty: "rgba(255,255,255,0.06)",
    heat1: "#2D6A4F",
    heat2: "#40916C",
    heat3: "#6FCF97",
  },
};
let T = themes.light;
const font = {
  display: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  body: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  mono: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  serif: "'Fraunces', 'Source Serif Pro', Georgia, 'Times New Roman', serif",
};
// ─── i18n ───
const i18n = {
  "pt-BR": {
    practice: "praticar",
    words: "palavras",
    progress: "progresso",
    settings: "ajustes",
    allCaughtUp: "tudo em dia",
    startHere: "comece aqui",
    addFirstWord: "adicionar primeira palavra",
    addWordsToStart: "adicione palavras para começar a praticar",
    nextReview: "próxima revisão",
    modeType: "Digitar",
    modeWrite: "Escrever",
    typeAnswerPt: "Digite em português...",
    typeAnswerEn: "Digite em inglês...",
    check: "Verificar",
    yourAnswer: "Sua resposta",
    clear: "Limpar",
    listenPronunciation: "ouvir pronúncia",
    stopPronunciation: "parar",
    suspend: "suspender",
    unsuspend: "reativar",
    suspended: "suspensas",
    startTimer: "iniciar tempo",
    stopTimer: "parar tempo",
    timerRunning: "estudando",
    timerAutoStopped: "tempo parado — você esteve ausente",
    totalTime: "tempo total",
    editTimeLogs: "editar registros de tempo",
    editTimeLogsHint: "Aceita formatos como 30m, 1h, 1h 30m ou 90.",
    noTimeLogs: "Nenhum registro de tempo ainda.",
    minutesLabel: "min",
    deleteEntry: "excluir",
    studyTimeReport: "Tempo de estudo",
    periodDay: "Dia",
    periodWeek: "Semana",
    periodMonth: "Mês",
    periodYear: "Ano",
    exportStudyTime: "exportar tempo",
    exportStudyTimeDesc: "Baixe seu tempo de estudo como CSV (uma linha por dia).",
    skip: "Pular",
    forgot: "Errei",
    partiallyRecalled: "Difícil",
    recalledWithEffort: "Bom",
    easilyRecalled: "Fácil",
    import: "importar",
    newWord: "+ novo",
    close: "fechar",
    noWordsYet: "nenhuma palavra adicionada ainda",
    newCard: "Novo",
    today: "Hoje",
    notAvailable: "N/D",
    upNext: "próxima",
    addPriority: "estudar em seguida",
    removePriority: "remover prioridade",
    newCardsPerDay: "Cartas novas por dia",
    newCardsPerDayDesc: "Quantas cartas novas serão introduzidas em cada sessão.",
    deleteWord: "excluir palavra",
    importWords: "importar palavras",
    importDesc: "Importe suas palavras em massa usando um CSV ou texto colado. Use negrito para marcar a palavra-chave na frase.",
    uploadFile: "carregar arquivo",
    pasteHere: "Cole suas palavras aqui...",
    selectedOf: "de",
    selected: "selecionadas",
    selectAll: "selecionar tudo",
    deselectAll: "desmarcar tudo",
    add: "adicionar",
    word: "palavra",
    wordsPlural: "palavras",
    importedSuccess: "importadas com sucesso",
    importedSuccessSingular: "importada com sucesso",
    goToWords: "Acesse a aba palavras para ver e praticar.",
    noWordsRecognized: "nenhuma palavra reconhecida",
    checkFormat: "verifique se o formato está correto",
    linesNotRecognized: "linhas não reconhecidas",
    newWordTitle: "nova palavra",
    portuguese: "Português",
    english: "Inglês",
    boldHelper: "Use **asteriscos** ao redor da palavra-chave para marcá-la.",
    boldWarning: "Use **asteriscos** ao redor da palavra-chave",
    addButton: "adicionar",
    cancel: "cancelar",
    save: "salvar",
    editBoldHint: "Use negrito (Ctrl+B) para a palavra-chave",
    headerPalavra: "Palavra",
    headerEnglish: "Inglês",
    headerPortuguese: "Português",
    headerDue: "Revisão",
    headerStage: "Estágio",
    headerLastStudied: "Estudado",
    settingsTitle: "ajustes",
    dailyGoal: "Meta diária",
    dailyGoalDesc: "Quantas cartas você quer revisar por dia.",
    theme: "Tema",
    themeDesc: "Escolha entre o modo claro e escuro.",
    themeLight: "Claro",
    themeDark: "Escuro",
    language: "Idioma da interface",
    languageDesc: "Escolha o idioma dos elementos da interface.",
    cardOrder: "Ordem das cartas",
    cardOrderDesc: "Como as cartas aparecem durante a prática.",
    cardOrderDue: "Por data de revisão",
    cardOrderDueDesc: "Mais atrasadas primeiro",
    cardOrderNewest: "Mais recentes primeiro",
    cardOrderNewestDesc: "Cartões adicionados recentemente primeiro",
    exportData: "Exportar dados",
    exportDataDesc: "Baixe todas as suas cartas como arquivo CSV.",
    exportButton: "exportar",
    cardsAs: "cartas como CSV",
    cardAs: "carta como CSV",
    daysPracticed: "Dias Praticados",
    dayStreak: "dias seguidos",
    daysStudied: "dias estudados",
    daysInARow: "dias seguidos",
    less: "menos",
    more: "mais",
    review1: "revisão",
    reviewN: "revisões",
    totalWords: "total de palavras",
    totalReviews: "revisões totais",
    avgPerDay: "média por dia",
    loading: "carregando...",
    stageNew: "Novo",
    stageLearning: "Aprendendo",
    stageYoung: "Jovem",
    stageMature: "Maduro",
    stageMastered: "Dominado",
    stageSuspended: "Suspenso",
    stageBreakdown: "Progresso por estágio",
    recallRate: "Taxa de retenção",
    recallStrong: "Forte",
    recallGood: "Bom",
    recallFading: "Apagando",
    recallAtRisk: "Em risco",
    recallLabel: "retenção",
    studyActivity: "Atividade de estudo",
    studyActivityDesc: "Palavras revisadas por dia",
    wordsReviewed: "Palavras revisadas",
    thisWeek: "Esta semana",
    thisMonth: "Este mês",
    thisYear: "Este ano",
    apiKey: "Chave de API Gemini",
    apiKeyDesc: "Chave gratuita do Google AI Studio (aistudio.google.com). Armazenada só no seu dispositivo.",
    apiKeyPlaceholder: "AIza...",
    apiKeySaved: "Chave salva ✓",
    sheetsSync: "Sincronização Google Sheets",
    sheetsSyncDesc: "Mantenha seus cartões sincronizados em todos os dispositivos via Google Sheets. Cole a URL do Apps Script abaixo.",
    sheetsSyncWarn: "⚠ Esta URL funciona como uma chave de acesso aos seus dados. Não compartilhe screenshots desta tela nem cole a URL em mensagens.",
    backupSection: "Backup e restauração",
    backupSectionDesc: "Baixe uma cópia completa dos seus dados ou restaure de um backup anterior.",
    exportBackup: "Baixar backup",
    importBackup: "Restaurar backup",
    importBackupConfirm: "Importar este backup vai substituir todos os dados atuais. Continuar?",
    importBackupSuccess: "Backup restaurado. Recarregando…",
    importBackupInvalid: "Arquivo de backup inválido.",
    restoreFromSnapshot: "Restaurar de snapshot",
    snapshotPickerTitle: "Escolha um snapshot para restaurar",
    snapshotPickerEmpty: "Nenhum snapshot disponível ainda.",
    snapshotPickerError: "Não foi possível listar os snapshots.",
    backupHealthTitle: "Estado do backup",
    backupHealthLastSync: "Última sincronização",
    backupHealthLastSnapshot: "Último snapshot automático",
    backupHealthLastManual: "Último backup manual",
    backupHealthTotalCards: "Total de cartas",
    backupHealthNever: "nunca",
    backupHealthJustNow: "agora",
    backupHealthDaysAgo: "dias atrás",
    backupHealthHoursAgo: "horas atrás",
    backupHealthMinutesAgo: "minutos atrás",
    sheetsSave: "Salvar e sincronizar",
    sheetsSyncing: "sincronizando...",
    sheetsSynced: "Sincronizado ✓",
    sheetsError: "Erro de sincronização",
    sheetsLastSync: "Última sincronização",
    searchPlaceholder: "buscar palavras ou frases...",
    groupByStage: "agrupar",
    sortBy: "ordenar",
    sortAdded: "Adicionado",
    sortAsc: "Crescente",
    sortDesc: "Decrescente",
  },
  en: {
    practice: "practice",
    words: "words",
    progress: "progress",
    settings: "settings",
    allCaughtUp: "all caught up",
    startHere: "start here",
    addFirstWord: "add your first word",
    addWordsToStart: "add words to start practising",
    nextReview: "next review",
    modeType: "Type",
    modeWrite: "Write",
    typeAnswerPt: "Type in Portuguese...",
    typeAnswerEn: "Type in English...",
    check: "Check",
    yourAnswer: "Your answer",
    clear: "Clear",
    listenPronunciation: "listen to pronunciation",
    stopPronunciation: "stop",
    suspend: "suspend",
    unsuspend: "unsuspend",
    suspended: "suspended",
    startTimer: "start timer",
    stopTimer: "stop timer",
    timerRunning: "studying",
    timerAutoStopped: "timer auto-stopped — you were away",
    totalTime: "total time",
    editTimeLogs: "edit time logs",
    editTimeLogsHint: "Accepts formats like 30m, 1h, 1h 30m, or 90.",
    noTimeLogs: "No time logs yet.",
    minutesLabel: "min",
    deleteEntry: "delete",
    studyTimeReport: "Study time",
    periodDay: "Day",
    periodWeek: "Week",
    periodMonth: "Month",
    periodYear: "Year",
    exportStudyTime: "export time",
    exportStudyTimeDesc: "Download your study time as CSV (one row per day).",
    skip: "Skip",
    forgot: "Again",
    partiallyRecalled: "Hard",
    recalledWithEffort: "Good",
    easilyRecalled: "Easy",
    import: "import",
    newWord: "+ new",
    close: "close",
    noWordsYet: "no words added yet",
    newCard: "New",
    today: "Today",
    notAvailable: "N/A",
    upNext: "up next",
    addPriority: "study next",
    removePriority: "remove priority",
    newCardsPerDay: "New cards per day",
    newCardsPerDayDesc: "How many new cards are introduced in each study session.",
    deleteWord: "delete word",
    importWords: "import words",
    importDesc: "Import your words in bulk using a CSV or pasted text. Use bold to mark the keyword in the sentence.",
    uploadFile: "upload file",
    pasteHere: "Paste your words here...",
    selectedOf: "of",
    selected: "selected",
    selectAll: "select all",
    deselectAll: "deselect all",
    add: "add",
    word: "word",
    wordsPlural: "words",
    importedSuccess: "imported successfully",
    importedSuccessSingular: "imported successfully",
    goToWords: "Go to the words tab to view and practise.",
    noWordsRecognized: "no words recognised",
    checkFormat: "check the format is correct",
    linesNotRecognized: "lines not recognised",
    newWordTitle: "new word",
    portuguese: "Portuguese",
    english: "English",
    boldHelper: "Wrap the keyword in **asterisks** to mark the word in focus.",
    boldWarning: "Use **asterisks** around the keyword",
    addButton: "add",
    cancel: "cancel",
    save: "save",
    editBoldHint: "Use bold (Ctrl+B) for keyword",
    headerPalavra: "Keyword",
    headerEnglish: "English",
    headerPortuguese: "Portuguese",
    headerDue: "Due",
    headerStage: "Stage",
    headerLastStudied: "Studied",
    settingsTitle: "settings",
    dailyGoal: "Daily goal",
    dailyGoalDesc: "How many cards you want to review per day.",
    theme: "Theme",
    themeDesc: "Choose between light and dark mode.",
    themeLight: "Light",
    themeDark: "Dark",
    language: "Interface language",
    languageDesc: "Choose the language for UI elements.",
    cardOrder: "Card order",
    cardOrderDesc: "How cards appear during practice.",
    cardOrderDue: "By due date",
    cardOrderDueDesc: "Most overdue first",
    cardOrderNewest: "Newest first",
    cardOrderNewestDesc: "Recently added cards first",
    exportData: "Export data",
    exportDataDesc: "Download all your cards as a CSV file.",
    exportButton: "export",
    cardsAs: "cards as CSV",
    cardAs: "card as CSV",
    daysPracticed: "Days Practised",
    dayStreak: "day streak",
    daysStudied: "days studied",
    daysInARow: "days in a row",
    less: "less",
    more: "more",
    review1: "review",
    reviewN: "reviews",
    totalWords: "total words",
    totalReviews: "total reviews",
    avgPerDay: "average per day",
    loading: "loading...",
    stageNew: "New",
    stageLearning: "Learning",
    stageYoung: "Young",
    stageMature: "Mature",
    stageMastered: "Mastered",
    stageSuspended: "Suspended",
    stageBreakdown: "Progress by stage",
    recallRate: "Recall rate",
    recallStrong: "Strong",
    recallGood: "Good",
    recallFading: "Fading",
    recallAtRisk: "At risk",
    recallLabel: "recall",
    studyActivity: "Study activity",
    studyActivityDesc: "Words reviewed per day",
    wordsReviewed: "Words reviewed",
    thisWeek: "This week",
    thisMonth: "This month",
    thisYear: "This year",
    apiKey: "Gemini API Key",
    apiKeyDesc: "Free key from Google AI Studio (aistudio.google.com). Stored only on your device.",
    apiKeyPlaceholder: "AIza...",
    apiKeySaved: "Key saved ✓",
    sheetsSync: "Google Sheets Sync",
    sheetsSyncDesc: "Keep your cards synced across all devices via Google Sheets. Paste your Apps Script URL below.",
    sheetsSyncWarn: "⚠ This URL functions as the access key to your data. Don't share screenshots of this panel or paste the URL into chats.",
    backupSection: "Backup & restore",
    backupSectionDesc: "Download a full copy of your data or restore from a previous backup.",
    exportBackup: "Download backup",
    importBackup: "Restore backup",
    importBackupConfirm: "Importing this backup will replace all current data. Continue?",
    importBackupSuccess: "Backup restored. Reloading…",
    importBackupInvalid: "Invalid backup file.",
    restoreFromSnapshot: "Restore from snapshot",
    snapshotPickerTitle: "Choose a snapshot to restore",
    snapshotPickerEmpty: "No snapshots available yet.",
    snapshotPickerError: "Couldn't list snapshots.",
    backupHealthTitle: "Backup status",
    backupHealthLastSync: "Last sync",
    backupHealthLastSnapshot: "Last auto-snapshot",
    backupHealthLastManual: "Last manual backup",
    backupHealthTotalCards: "Total cards",
    backupHealthNever: "never",
    backupHealthJustNow: "just now",
    backupHealthDaysAgo: "days ago",
    backupHealthHoursAgo: "hours ago",
    backupHealthMinutesAgo: "minutes ago",
    sheetsSave: "Save & sync",
    sheetsSyncing: "syncing...",
    sheetsSynced: "Synced ✓",
    sheetsError: "Sync error",
    sheetsLastSync: "Last synced",
    searchPlaceholder: "search words or phrases...",
    groupByStage: "group",
    sortBy: "sort",
    sortAdded: "Added",
    sortAsc: "Ascending",
    sortDesc: "Descending",
  },
};
let t = i18n["pt-BR"];
// ─── Heatmap Component ───
function CalendarHeatmap({ practiceDays, year, onYearChange }) {
  const [tooltip, setTooltip] = useState(null);
  const gridRef = useRef(null);
  const days = getDaysInYear(year);
  const maxCount = Math.max(1, ...Object.values(practiceDays).map(totalForDay).filter(Boolean));
  const weeks = [];
  let currentWeek = new Array(7).fill(null);
  const firstDay = getWeekday(days[0]);
  for (let i = 0; i < firstDay; i++) currentWeek[i] = null;
  days.forEach((day) => {
    const wd = getWeekday(day);
    currentWeek[wd] = day;
    if (wd === 6) { weeks.push(currentWeek); currentWeek = new Array(7).fill(null); }
  });
  if (currentWeek.some((d) => d !== null)) weeks.push(currentWeek);
  const getColor = (day) => {
    if (!day) return "transparent";
    const count = totalForDay(practiceDays[day]);
    if (count === 0) return T.heatEmpty;
    if (count < 10) return T.heat1;
    if (count <= 30) return T.heat2;
    return T.heat3;
  };
  const monthPositions = [];
  let lastMonth = -1;
  weeks.forEach((week, wi) => {
    const validDay = week.find((d) => d !== null);
    if (validDay) {
      const m = getMonth(validDay);
      if (m !== lastMonth) { monthPositions.push({ month: m, weekIndex: wi }); lastMonth = m; }
    }
  });
  const totalDays = Object.values(practiceDays).filter((v) => totalForDay(v) > 0).length;
  const currentStreak = (() => {
    let streak = 0;
    let d = new Date();
    if (totalForDay(practiceDays[localDateStr(d)]) === 0) {
      d.setDate(d.getDate() - 1);
    }
    while (true) {
      const ds = localDateStr(d);
      if (totalForDay(practiceDays[ds]) > 0) { streak++; d.setDate(d.getDate() - 1); } else break;
    }
    return streak;
  })();
  const totalWeeks = weeks.length;
  const gap = 2;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
          <span style={{ fontFamily: font.display, fontSize: 15, fontWeight: 700, color: T.text }}>
            {t.daysPracticed}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => onYearChange(year - 1)} style={{
            background: T.accentSoft, border: `1px solid ${T.border}`, color: T.text,
            borderRadius: 9999, width: 34, height: 34, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "all 0.2s",
          }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.text} strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span style={{ fontFamily: font.body, fontSize: 15, fontWeight: 600, color: T.text, minWidth: 48, textAlign: "center" }}>{year}</span>
          <button onClick={() => onYearChange(year + 1)} style={{
            background: T.accentSoft, border: `1px solid ${T.border}`, color: T.text,
            borderRadius: 9999, width: 34, height: 34, cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            transition: "all 0.2s",
          }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.text} strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>
      <div style={{ position: "relative", marginBottom: 4, height: 14 }}>
        {monthPositions.map(({ month, weekIndex }) => (
          <span key={month} style={{
            position: "absolute",
            left: `${(weekIndex / totalWeeks) * 100}%`,
            fontFamily: font.mono, fontSize: 9, color: T.textTertiary, letterSpacing: 0.5,
          }}>
            {MONTH_LABELS[month]}
          </span>
        ))}
      </div>
      <div ref={gridRef} style={{
        display: "grid",
        gridTemplateColumns: `repeat(${totalWeeks}, 1fr)`,
        gap: gap,
        width: "100%",
      }}>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: "flex", flexDirection: "column", gap: gap }}>
            {week.map((day, di) => (
              <div
                key={di}
                style={{
                  width: "100%",
                  paddingBottom: "100%",
                  borderRadius: 2,
                  background: getColor(day),
                  cursor: day && totalForDay(practiceDays[day]) > 0 ? "pointer" : "default",
                }}
                onMouseEnter={(e) => {
                  if (!day) return;
                  const count = totalForDay(practiceDays[day]);
                  if (count === 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  setTooltip({
                    day,
                    count,
                    x: rect.left + rect.width / 2,
                    y: rect.top,
                  });
                }}
                onMouseLeave={() => setTooltip(null)}
              />
            ))}
          </div>
        ))}
      </div>
      {tooltip && (
        <div style={{
          position: "fixed",
          left: tooltip.x,
          top: tooltip.y - 6,
          transform: "translate(-50%, -100%)",
          background: T.bgCard,
          color: T.text,
          border: `1px solid ${T.borderStrong}`,
          borderRadius: 8,
          padding: "5px 10px",
          fontFamily: font.mono,
          fontSize: 11,
          fontWeight: 500,
          whiteSpace: "nowrap",
          boxShadow: T.shadowLg,
          pointerEvents: "none",
          zIndex: 9999,
        }}>
          <span style={{ fontWeight: 700 }}>{tooltip.count}</span>
          <span style={{ color: T.textTertiary }}> {tooltip.count === 1 ? t.review1 : t.reviewN} </span>
          <span style={{ color: T.textTertiary }}>&middot; {tooltip.day}</span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 3, marginTop: 10 }}>
        <span style={{ fontFamily: font.mono, fontSize: 9, color: T.textTertiary, marginRight: 2 }}>{t.less}</span>
        {[T.heatEmpty, T.heat1, T.heat2, T.heat3].map((c, i) => (
          <div key={i} style={{ width: 10, height: 10, borderRadius: 2, background: c }} />
        ))}
        <span style={{ fontFamily: font.mono, fontSize: 9, color: T.textTertiary, marginLeft: 2 }}>{t.more}</span>
      </div>
    </div>
  );
}
const yearBtnStyle = {
  background: "none",
  border: `1px solid ${T.border}`,
  color: T.textSecondary,
  borderRadius: 6,
  padding: "2px 8px",
  cursor: "pointer",
  fontFamily: font.mono,
  fontSize: 13,
  lineHeight: 1,
};
// ─── HTML Bold Parser ───
// Detect whether a DOM element is rendering as bold. Browsers in contentEditable
// produce many shapes: <b>, <strong>, <span style="font-weight:bold">, numeric weights,
// or a parent with `font-weight` inherited. We check both inline styles and computed styles.
const isElementBold = (node) => {
  const tag = node.tagName ? node.tagName.toLowerCase() : "";
  if (tag === "b" || tag === "strong") return true;
  const fw = node.style && node.style.fontWeight;
  if (fw) {
    const s = String(fw).toLowerCase().trim();
    if (s === "bold" || s === "bolder") return true;
    const n = parseInt(s, 10);
    if (!isNaN(n) && n >= 600) return true;
  }
  // Last resort: read the computed style if the node is in the DOM
  if (node.ownerDocument && node.ownerDocument.defaultView) {
    try {
      const cs = node.ownerDocument.defaultView.getComputedStyle(node);
      const cfw = cs && cs.fontWeight;
      if (cfw) {
        const s = String(cfw).toLowerCase().trim();
        if (s === "bold" || s === "bolder") return true;
        const n = parseInt(s, 10);
        if (!isNaN(n) && n >= 600) return true;
      }
    } catch {}
  }
  return false;
};
const parseHtmlBold = (html) => {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  let plain = "";
  const rawSpans = []; // array of [start, end] pairs, one per bold run
  const walk = (node, inheritedBold = false) => {
    if (node.nodeType === 3) { plain += node.textContent; return; }
    if (node.nodeType !== 1) return;
    const isBold = inheritedBold || isElementBold(node);
    const start = plain.length;
    for (const child of node.childNodes) walk(child, isBold);
    const end = plain.length;
    // Only outermost bolds push a span — avoids double-counting nested <b><strong>...
    if (isBold && !inheritedBold && end > start) rawSpans.push([start, end]);
  };
  for (const child of tmp.childNodes) walk(child);
  // Merge adjacent / overlapping spans (Chrome often emits <b>a</b><b>b</b> as two runs)
  rawSpans.sort((a, b) => a[0] - b[0]);
  const spans = [];
  for (const [s, e] of rawSpans) {
    if (spans.length && s <= spans[spans.length - 1][1]) {
      spans[spans.length - 1][1] = Math.max(spans[spans.length - 1][1], e);
    } else {
      spans.push([s, e]);
    }
  }
  // Derived/legacy fields for backwards compatibility with old callers
  const kwTexts = spans.map(([s, e]) => plain.slice(s, e));
  const kwText = kwTexts.join(" | ");
  const kwStart = spans.length > 0 ? spans[0][0] : null;
  const kwEnd = spans.length > 0 ? spans[0][1] : null;
  return { plain, spans, kwStart, kwEnd, kwText, kwTexts };
};
// Resolve a card's keyword spans, supporting both new (keywordSpans) and legacy (keywordStart/keywordEnd) shapes.
const getKeywordSpans = (card) => {
  if (Array.isArray(card.keywordSpans) && card.keywordSpans.length > 0) {
    return card.keywordSpans.filter(([s, e]) => typeof s === "number" && typeof e === "number" && e > s);
  }
  if (card.keywordStart !== undefined && card.keywordEnd !== undefined && card.keywordStart !== card.keywordEnd) {
    return [[card.keywordStart, card.keywordEnd]];
  }
  return [];
};
// Rebuild HTML from a phrase + spans (used when opening the edit modal).
const phraseToHtml = (phrase, spans, escapeFn) => {
  const esc = escapeFn || ((s) => s);
  if (!phrase) return "";
  if (!spans || spans.length === 0) return esc(phrase);
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let html = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    const s = Math.max(cursor, start);
    if (s > cursor) html += esc(phrase.slice(cursor, s));
    if (end > s) html += "<b>" + esc(phrase.slice(s, end)) + "</b>";
    cursor = Math.max(cursor, end);
  }
  if (cursor < phrase.length) html += esc(phrase.slice(cursor));
  return html;
};
// ─── Phrase Display ───
function PhraseDisplay({ phrase, spans, keywordStart, keywordEnd, size = "normal", mobile = false, fontSize }) {
  if (!phrase) return null;
  // Resolve spans: new prop wins, otherwise fall back to legacy single-span props.
  let effective = Array.isArray(spans) ? spans : null;
  if ((!effective || effective.length === 0) &&
      keywordStart !== undefined && keywordEnd !== undefined && keywordStart !== keywordEnd) {
    effective = [[keywordStart, keywordEnd]];
  }
  const isHero = size === "hero";
  const fs = fontSize != null ? fontSize : (isHero ? (mobile ? 32 : 56) : size === "large" ? 20 : size === "practice" ? 24 : 14);
  const textColor = isHero || size === "practice" ? T.text : T.textSecondary;
  const fontFamily = isHero ? font.serif : font.body;
  const fontWeight = isHero ? 600 : 400;
  const lineHeight = isHero ? 1.15 : 1.7;
  const letterSpacing = isHero ? "-0.01em" : "normal";
  const boldStyle = isHero
    ? { color: T.keyword, fontWeight: 700, background: T.keywordBg, padding: "0 0.12em", borderRadius: 6 }
    : { color: T.keyword, fontWeight: 700, background: T.keywordBg, padding: "2px 4px", borderRadius: 4 };
  const wrap = { fontSize: fs, lineHeight, fontFamily, fontWeight, letterSpacing };
  if (!effective || effective.length === 0) {
    return <span style={wrap}><span style={{ color: textColor }}>{phrase}</span></span>;
  }
  const sorted = [...effective].sort((a, b) => a[0] - b[0]);
  const parts = [];
  let cursor = 0;
  sorted.forEach(([start, end], i) => {
    const s = Math.max(cursor, start);
    if (s > cursor) parts.push(<span key={`p${i}`} style={{ color: textColor }}>{phrase.slice(cursor, s)}</span>);
    if (end > s) parts.push(<span key={`b${i}`} style={boldStyle}>{phrase.slice(s, end)}</span>);
    cursor = Math.max(cursor, end);
  });
  if (cursor < phrase.length) parts.push(<span key="tail" style={{ color: textColor }}>{phrase.slice(cursor)}</span>);
  return <span style={wrap}>{parts}</span>;
}
// ─── Speaker Icon ───
function SpeakerIcon({ size = 18, color = T.textTertiary }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill={color} opacity="0.15" />
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}
function StopIcon({ size = 18, color = T.textTertiary }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
function PencilIcon({ size = 18, color = T.textTertiary }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}
// Closed eye — represents "suspend" (hide this card from the queue)
function SuspendIcon({ size = 18, color = T.textTertiary }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="m14.12 14.12-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}
// Open eye — represents "unsuspend" (bring the card back into rotation)
function UnsuspendIcon({ size = 18, color = T.textTertiary }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
// Phase-of-moon icon: visual indicator for the FSRS rating scale.
// fill 0 → empty circle, 0.5 → half-filled, 1 → fully filled.
let moonIdCounter = 0;
function MoonShapeIcon({ fill = 0, size = 18, color = T.text, pie = false }) {
  const r = size / 2;
  const cr = r - 0.75; // circle radius leaving room for the 1.5px stroke
  const cid = useMemo(() => `moon${moonIdCounter++}`, []);
  // Pie mode: filled wedge of `fill` fraction with the cut-out slice centered on the right.
  const piePath = (() => {
    if (!pie || fill <= 0 || fill >= 1) return null;
    const cut = (1 - fill) * 360;
    const a0 = cut / 2, a1 = 360 - cut / 2;
    const xy = (deg) => {
      const rad = (deg * Math.PI) / 180;
      return `${(r + cr * Math.cos(rad)).toFixed(2)} ${(r + cr * Math.sin(rad)).toFixed(2)}`;
    };
    const largeArc = (a1 - a0) > 180 ? 1 : 0;
    return `M ${r} ${r} L ${xy(a0)} A ${cr} ${cr} 0 ${largeArc} 1 ${xy(a1)} Z`;
  })();
  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden
      style={{ flexShrink: 0, display: "inline-block", verticalAlign: "middle" }}
    >
      <circle cx={r} cy={r} r={cr} fill="none" stroke={color} strokeWidth="1.5" />
      {fill > 0 && (
        pie ? (
          fill >= 1
            ? <circle cx={r} cy={r} r={cr} fill={color} />
            : <path d={piePath} fill={color} />
        ) : (
          <>
            <defs>
              <clipPath id={cid}><circle cx={r} cy={r} r={cr} /></clipPath>
            </defs>
            <rect x="0" y="0" width={size * fill} height={size} fill={color} clipPath={`url(#${cid})`} />
          </>
        )
      )}
    </svg>
  );
}
function SkipForwardIcon({ size = 18, color = T.text }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5,4 15,12 5,20" fill={color} stroke={color} />
      <line x1="18.5" y1="5" x2="18.5" y2="19" />
    </svg>
  );
}
function XMarkIcon({ size = 18, color = T.text }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}
function RefreshIcon({ size = 18, color = T.text }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}
// ─── Add Card Form ───
function AddCardForm({ onAdd, onCancel }) {
  const [ptText, setPtText] = useState("");
  const [enText, setEnText] = useState("");
  const parseBold = (text) => {
    const match = text.match(/\*\*(.+?)\*\*/);
    if (!match) return null;
    const plain = text.replace(/\*\*/g, "");
    const keyword = match[1];
    const before = text.substring(0, text.indexOf("**"));
    const start = before.length;
    return { phrase: plain, word: keyword, keywordStart: start, keywordEnd: start + keyword.length };
  };
  const parsed = ptText.trim() ? parseBold(ptText.trim()) : null;
  const canSubmit = enText.trim() && ptText.trim() && parsed;
  const handleSubmit = () => {
    if (!canSubmit) return;
    onAdd(FSRS.defaultCard(parsed.word, enText.trim(), parsed.phrase, parsed.keywordStart, parsed.keywordEnd));
    setPtText(""); setEnText("");
  };
  const inputStyle = {
    width: "100%",
    padding: "13px 16px",
    background: T.bgInput,
    border: "1px solid transparent",
    borderRadius: T.radiusSm,
    color: T.text,
    fontFamily: font.body,
    fontSize: 15,
    outline: "none",
    transition: "border-color 0.2s, box-shadow 0.2s",
    boxSizing: "border-box",
  };
  const labelStyle = {
    fontFamily: font.mono,
    fontSize: 10,
    color: T.textTertiary,
    textTransform: "uppercase",
    letterSpacing: 1.8,
    marginBottom: 8,
    display: "block",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div>
        <label style={labelStyle}>{t.portuguese}</label>
        <input
          style={inputStyle}
          value={ptText}
          onChange={(e) => setPtText(e.target.value)}
          placeholder="Que apartamento **aconchegante**!"
          onFocus={(e) => { e.target.style.borderColor = T.borderStrong; e.target.style.boxShadow = "0 0 0 3px rgba(0,0,0,0.03)"; }}
          onBlur={(e) => { e.target.style.borderColor = "transparent"; e.target.style.boxShadow = "none"; }}
        />
        {ptText.trim() && parsed && (
          <div style={{ marginTop: 10, padding: "8px 12px", background: T.keywordBg, borderRadius: 8 }}>
            <PhraseDisplay phrase={parsed.phrase} keywordStart={parsed.keywordStart} keywordEnd={parsed.keywordEnd} />
          </div>
        )}
        {ptText.trim() && !parsed && (
          <div style={{ marginTop: 8, fontFamily: font.body, fontSize: 12, color: T.warning }}>
            {t.boldWarning}
          </div>
        )}
        {!ptText.trim() && (
          <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginTop: 10, lineHeight: 1.5 }}>
            {t.boldHelper}
          </div>
        )}
      </div>
      <div>
        <label style={labelStyle}>{t.english}</label>
        <input
          style={inputStyle}
          value={enText}
          onChange={(e) => setEnText(e.target.value)}
          placeholder="cozy, snug"
          onFocus={(e) => { e.target.style.borderColor = T.borderStrong; e.target.style.boxShadow = "0 0 0 3px rgba(0,0,0,0.03)"; }}
          onBlur={(e) => { e.target.style.borderColor = "transparent"; e.target.style.boxShadow = "none"; }}
        />
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        {onCancel && (
          <button onClick={onCancel} style={{ padding: "11px 22px", background: "none", border: `1px solid ${T.border}`, borderRadius: T.radiusSm, color: T.textSecondary, fontFamily: font.body, fontSize: 14, cursor: "pointer", transition: "all 0.15s" }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.color = T.text; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textSecondary; }}
          >
            cancelar
          </button>
        )}
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={{
            padding: "11px 28px",
            background: canSubmit ? T.accent : T.bgInput,
            border: "none",
            borderRadius: T.radiusSm,
            color: canSubmit ? T.bg : T.textPlaceholder,
            fontFamily: font.body,
            fontSize: 14,
            fontWeight: 600,
            cursor: canSubmit ? "pointer" : "default",
            transition: "all 0.2s",
            letterSpacing: 0.3,
          }}
          onMouseEnter={(e) => { if (canSubmit) e.currentTarget.style.opacity = "0.85"; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
        >
          adicionar
        </button>
      </div>
    </div>
  );
}
// ─── Drawing Canvas ───
const DrawingCanvas = memo(forwardRef(function DrawingCanvas({ height = 200, onDrawingChange }, ref) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const mobile = useIsMobile();

  useImperativeHandle(ref, () => ({
    clear: () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (onDrawingChange) onDrawingChange(false);
    },
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = T.text;
  }, []);

  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e) => {
    drawing.current = true;
    canvasRef.current.setPointerCapture(e.pointerId);
    const ctx = canvasRef.current.getContext("2d");
    ctx.strokeStyle = T.text;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineWidth = 1.5 + (e.pressure || 0.5) * 3;
    if (onDrawingChange) onDrawingChange(true);
  };

  const onPointerMove = (e) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current.getContext("2d");
    const { x, y } = getPos(e);
    ctx.lineWidth = 1.5 + (e.pressure || 0.5) * 3;
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const onPointerUp = () => { drawing.current = false; };

  const handleClear = (e) => {
    e.stopPropagation();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (onDrawingChange) onDrawingChange(false);
  };

  return (
    <div style={{ position: "relative" }}>
      <canvas
        ref={canvasRef}
        style={{
          width: "100%", height, display: "block",
          background: T.bgInput, borderRadius: T.radius,
          border: `1px solid ${T.border}`, touchAction: "none",
          cursor: "crosshair",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      />
      <button
        onClick={handleClear}
        style={{
          position: "absolute", top: 8, right: 8,
          background: T.bgCard, border: `1px solid ${T.border}`,
          borderRadius: T.radiusSm, padding: "4px 12px",
          fontFamily: font.mono, fontSize: 11, color: T.textTertiary,
          cursor: "pointer", transition: "all 0.15s",
        }}
      >
        {t.clear}
      </button>
    </div>
  );
}));
// ─── Practice Card ───
function PracticeCard({ card, onReview, onSkip, onUpdate, onSuspend, totalDue, studyDirection, answerMode: answerModeProp = "type", setAnswerMode, activeSession, liveElapsed, onStartTimer, onStopTimer }) {
  const mobile = useIsMobile();
  // Drawing/"escrever" mode is desktop-only; mobile is always type mode.
  const answerMode = mobile ? "type" : answerModeProp;
  const [flipped, setFlipped] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editPt, setEditPt] = useState("");
  const [editEn, setEditEn] = useState("");
  const [userAnswer, setUserAnswer] = useState("");
  const [score, setScore] = useState(null);
  const [hasRevealed, setHasRevealed] = useState(false);
  const [hasDrawing, setHasDrawing] = useState(false);
  const drawRef = useRef(null);
  const ptRef = useRef(null);
  const enRef = useRef(null);
  const handleCheck = (e) => {
    if (e) e.stopPropagation();
    const s = computeScore(userAnswer, card, studyDirection);
    setScore(s);
    setFlipped(true);
    setHasRevealed(true);
  };
  const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const startEdit = (e) => {
    e.stopPropagation();
    const existingSpans = getKeywordSpans(card);
    if (card.phrase && existingSpans.length > 0) {
      setEditPt(phraseToHtml(card.phrase, existingSpans, escHtml));
    } else {
      setEditPt(escHtml(card.word || ""));
    }
    setEditEn(escHtml(card.translation || ""));
    setEditing(true);
  };
  const saveEdit = () => {
    const ptHtml = ptRef.current ? ptRef.current.innerHTML : editPt;
    const enHtml = enRef.current ? enRef.current.innerHTML : editEn;
    const { plain, spans, kwTexts } = parseHtmlBold(ptHtml);
    const updated = {};
    if (spans.length > 0) {
      updated.phrase = plain;
      updated.word = kwTexts.join(" | ");
      updated.keywordSpans = spans;
      // Keep legacy fields pointing at the first span for any code path that still reads them.
      updated.keywordStart = spans[0][0];
      updated.keywordEnd = spans[0][1];
    } else {
      updated.word = plain;
      updated.phrase = "";
      updated.keywordSpans = [];
      updated.keywordStart = 0;
      updated.keywordEnd = 0;
    }
    const tmp = document.createElement("div");
    tmp.innerHTML = enHtml;
    updated.translation = tmp.textContent || "";
    onUpdate(card.id, updated);
    setEditing(false);
  };
  const cancelEdit = (e) => { e.stopPropagation(); setEditing(false); };
  const handleSpeak = (text) => {
    if (isSpeaking) { stopPT(); setIsSpeaking(false); return; }
    setIsSpeaking(true);
    speakPT(text, () => setIsSpeaking(false));
  };
  const handleReview = (quality) => {
    stopPT(); setIsSpeaking(false);
    if (quality === 0) {
      setExiting(true);
      setTimeout(() => { onSkip(card.id); setFlipped(false); setExiting(false); }, 280);
      return;
    }
    setExiting(true);
    setTimeout(() => { onReview(card.id, quality); setFlipped(false); setExiting(false); }, 280);
  };
  const intervals = previewIntervals(card);
  const qualityButtons = [
    { q: 0, label: t.skip, icon: <SkipForwardIcon size={20} color={T.text} />, days: null },
    { q: 1, label: t.forgot, icon: <XMarkIcon size={20} color={T.text} />, days: intervals[0] },
    { q: 2, label: t.partiallyRecalled, icon: <MoonShapeIcon fill={0.5} size={18} color={T.text} />, days: intervals[1] },
    { q: 3, label: t.recalledWithEffort, icon: <MoonShapeIcon fill={0.75} pie size={18} color={T.text} />, days: intervals[2] },
    { q: 4, label: t.easilyRecalled, icon: <MoonShapeIcon fill={1} size={18} color={T.text} />, days: intervals[3] },
  ];
  const renderQualityBtn = (btn) => (
    <button
      key={btn.q}
      onClick={() => handleReview(btn.q)}
      style={{
        padding: mobile ? "14px 8px" : "20px 12px",
        background: T.bgCard,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        cursor: "pointer",
        transition: "all 0.15s",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
        minHeight: mobile ? 92 : 108,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.bgCard; }}
    >
      <div style={{ height: 22, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 2 }}>
        {btn.icon}
      </div>
      <span style={{
        fontFamily: font.body, fontSize: mobile ? 13 : 14, fontWeight: 500,
        color: T.text, lineHeight: 1.2, textAlign: "center",
      }}>
        {btn.label}
      </span>
      {btn.days != null && (
        <span style={{
          fontFamily: font.mono, fontSize: 10, color: T.textTertiary,
          lineHeight: 1.2, textAlign: "center",
          letterSpacing: 0.3, fontVariantNumeric: "tabular-nums",
        }}>
          {formatFutureDate(btn.days)}
        </span>
      )}
    </button>
  );
  const renderSkipBtn = () => (
    <button
      onClick={() => handleReview(0)}
      style={{
        marginTop: mobile ? 8 : 12, width: "100%", padding: mobile ? "12px" : "13px",
        background: "transparent", border: `1px solid ${T.border}`,
        borderRadius: 14, cursor: "pointer", transition: "all 0.15s",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; }}
    >
      <SkipForwardIcon size={16} color={T.textSecondary} />
      <span style={{ fontFamily: font.body, fontSize: 13, fontWeight: 500, color: T.textSecondary }}>
        {t.skip}
      </span>
    </button>
  );
  // Which side of the card shows Portuguese (the side that gets the audio button)
  const showingPortuguese = flipped ? studyDirection === "en-pt" : studyDirection === "pt-en";
  const heroText = (() => {
    if (showingPortuguese) {
      if (card.phrase) {
        return (
          <PhraseDisplay
            phrase={card.phrase}
            spans={card.keywordSpans}
            keywordStart={card.keywordStart}
            keywordEnd={card.keywordEnd}
            size="hero"
            mobile={mobile}
          />
        );
      }
      return (
        <span style={{
          fontFamily: font.serif, fontSize: mobile ? 32 : 56, fontWeight: 600,
          color: T.text, lineHeight: 1.15, letterSpacing: "-0.01em",
        }}>
          {card.word}
        </span>
      );
    }
    return (
      <span style={{
        fontFamily: font.serif, fontSize: mobile ? 32 : 56, fontWeight: 600,
        color: T.text, lineHeight: 1.15, letterSpacing: "-0.01em",
      }}>
        {card.translation}
      </span>
    );
  })();
  const pillStyle = (active) => ({
    padding: "0 20px",
    height: 36,
    background: T.bgCard,
    border: `1px solid ${active ? T.text : T.border}`,
    borderRadius: 9999,
    color: active ? T.text : T.textSecondary,
    fontFamily: font.body, fontSize: mobile ? 11 : 12, fontWeight: 500,
    letterSpacing: 0.5,
    cursor: "pointer",
    transition: "all 0.15s",
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
    whiteSpace: "nowrap",
  });
  const circleIconStyle = {
    width: 36, height: 36, borderRadius: "50%",
    background: T.bgCard,
    border: `1px solid ${T.border}`,
    cursor: "pointer",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    transition: "all 0.15s",
    flexShrink: 0,
  };
  const onCircleEnter = (e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; };
  const onCircleLeave = (e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.bgCard; };
  // Listen-to-pronunciation as a circle icon button (speaker / stop while playing).
  const speakBtn = (
    <button
      onClick={() => handleSpeak(card.phrase || card.word)}
      aria-label={isSpeaking ? t.stopPronunciation : t.listenPronunciation}
      title={isSpeaking ? t.stopPronunciation : t.listenPronunciation}
      style={circleIconStyle} onMouseEnter={onCircleEnter} onMouseLeave={onCircleLeave}
    >
      {isSpeaking ? <StopIcon size={13} color={T.textSecondary} /> : <SpeakerIcon size={16} color={T.textSecondary} />}
    </button>
  );
  // Study timer: circle (play) when idle, blue pill with elapsed time when running.
  const timerBtn = (
    <button
      onClick={activeSession ? onStopTimer : onStartTimer}
      aria-label={activeSession ? t.stopTimer : t.startTimer}
      title={activeSession ? t.stopTimer : t.startTimer}
      style={activeSession
        ? { display: "inline-flex", alignItems: "center", gap: 7, height: 36, padding: "0 14px", borderRadius: 9999, background: T.bgCard, border: `1px solid ${T.border}`, cursor: "pointer", transition: "all 0.15s", fontFamily: font.mono, fontSize: 12, color: T.keyword, fontVariantNumeric: "tabular-nums", letterSpacing: 0.3, flexShrink: 0 }
        : circleIconStyle}
      onMouseEnter={onCircleEnter} onMouseLeave={onCircleLeave}
    >
      {activeSession ? (
        <>
          <StopIcon size={11} color={T.keyword} />
          <span>{formatDuration(liveElapsed)}</span>
        </>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill={T.textSecondary} stroke="none" aria-hidden>
          <polygon points="7,5 19,12 7,19" />
        </svg>
      )}
    </button>
  );
  return (
    <div style={{ opacity: exiting ? 0 : 1, transform: exiting ? "translateY(-16px)" : "translateY(0)", transition: "all 0.28s ease" }}>
      {editing ? (
        <div style={{ maxWidth: 600, margin: "0 auto", padding: mobile ? "16px 0" : "40px 0", textAlign: "left" }} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontFamily: font.mono, fontSize: 10, color: T.textTertiary, textTransform: "uppercase", letterSpacing: 2.5, marginBottom: 8 }}>
            {t.portuguese}
          </div>
          <div
            ref={ptRef}
            contentEditable
            suppressContentEditableWarning
            dangerouslySetInnerHTML={{ __html: editPt }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) e.preventDefault(); }}
            style={{
              padding: "12px 14px", background: T.bgInput, border: `1px solid ${T.border}`,
              borderRadius: T.radiusSm, color: T.text, fontFamily: font.body, fontSize: 17,
              outline: "none", minHeight: 44, marginBottom: 6, lineHeight: 1.5,
              wordBreak: "break-word", whiteSpace: "pre-wrap",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = T.borderStrong; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = T.border; }}
          />
          <div style={{ fontFamily: font.mono, fontSize: 9, color: T.textPlaceholder, marginBottom: 18 }}>
            {t.editBoldHint}
          </div>
          <div style={{ fontFamily: font.mono, fontSize: 10, color: T.textTertiary, textTransform: "uppercase", letterSpacing: 2.5, marginBottom: 8 }}>
            {t.english}
          </div>
          <div
            ref={enRef}
            contentEditable
            suppressContentEditableWarning
            dangerouslySetInnerHTML={{ __html: editEn }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) e.preventDefault(); }}
            style={{
              padding: "12px 14px", background: T.bgInput, border: `1px solid ${T.border}`,
              borderRadius: T.radiusSm, color: T.text, fontFamily: font.body, fontSize: 17,
              outline: "none", minHeight: 44, marginBottom: 22, lineHeight: 1.5,
              wordBreak: "break-word", whiteSpace: "pre-wrap",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = T.borderStrong; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = T.border; }}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={cancelEdit} style={{
              padding: "9px 22px", background: "transparent", border: `1px solid ${T.border}`,
              borderRadius: 9999, color: T.textSecondary, fontFamily: font.body,
              fontSize: 13, cursor: "pointer", transition: "all 0.15s",
            }}>
              {t.cancel}
            </button>
            <button onClick={saveEdit} style={{
              padding: "9px 22px", background: T.accent, border: "none",
              borderRadius: 9999, color: T.bg, fontFamily: font.body,
              fontSize: 13, fontWeight: 600, cursor: "pointer", transition: "all 0.15s",
            }}>
              {t.save}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ maxWidth: 1100, margin: "0 auto", width: "100%", padding: mobile ? "24px 0 0" : "96px 0 0" }}>
          {/* Language label */}
          <div style={{ textAlign: "center", marginBottom: mobile ? 12 : 24 }}>
            <span style={{
              fontFamily: font.body, fontSize: mobile ? 10 : 11, color: T.textTertiary,
              textTransform: "uppercase", letterSpacing: 3.5, fontWeight: 500,
            }}>
              {flipped
                ? (studyDirection === "en-pt" ? t.portuguese : t.english)
                : (studyDirection === "en-pt" ? t.english : t.portuguese)}
            </span>
          </div>
          {/* Big phrase */}
          <div
            onClick={() => {
              if (answerMode === "type" && !hasRevealed) return;
              if (!hasRevealed) { setFlipped(true); setHasRevealed(true); }
            }}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center",
              padding: mobile ? "0 16px" : "0 24px",
              cursor: (!hasRevealed && answerMode !== "type") ? "pointer" : "default",
            }}
          >
            <div style={{ maxWidth: mobile ? "100%" : 900 }}>
              {heroText}
            </div>
          </div>
          {/* Action button row */}
          <div style={{
            display: "flex", justifyContent: "center", alignItems: "center", gap: 8,
            marginTop: mobile ? 20 : 64, marginBottom: mobile ? 16 : 28,
            minHeight: 36, flexWrap: "wrap", padding: "0 16px",
          }}>
            {!hasRevealed ? (
              <>
                {!mobile && setAnswerMode && [
                  { id: "type", label: t.modeType },
                  { id: "write", label: t.modeWrite },
                ].map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => setAnswerMode(opt.id)}
                    style={pillStyle(answerMode === opt.id)}
                    onMouseEnter={(e) => {
                      if (answerMode !== opt.id) {
                        e.currentTarget.style.borderColor = T.borderStrong;
                        e.currentTarget.style.background = T.bgCardHover;
                      } else {
                        e.currentTarget.style.background = T.bgCardHover;
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = T.bgCard;
                      if (answerMode !== opt.id) e.currentTarget.style.borderColor = T.border;
                    }}
                  >
                    {opt.label.toLowerCase()}
                  </button>
                ))}
                {!mobile && setAnswerMode && (
                  <div aria-hidden style={{ width: 1, height: 20, background: T.border, margin: "0 6px" }} />
                )}
                {studyDirection === "pt-en" && speakBtn}
                {onSuspend && (
                  <button onClick={() => onSuspend(card.id)} aria-label={t.suspend} title={t.suspend}
                    style={circleIconStyle} onMouseEnter={onCircleEnter} onMouseLeave={onCircleLeave}>
                    <SuspendIcon size={15} color={T.textSecondary} />
                  </button>
                )}
                {onUpdate && (
                  <button onClick={startEdit} aria-label="Edit card"
                    style={circleIconStyle} onMouseEnter={onCircleEnter} onMouseLeave={onCircleLeave}>
                    <PencilIcon size={14} color={T.textSecondary} />
                  </button>
                )}
                {timerBtn}
              </>
            ) : (
              <>
                <button
                  onClick={() => setFlipped(f => !f)} aria-label="Flip card" title="Flip card"
                  style={circleIconStyle} onMouseEnter={onCircleEnter} onMouseLeave={onCircleLeave}
                >
                  <RefreshIcon size={14} color={T.textSecondary} />
                </button>
                <div aria-hidden style={{ width: 1, height: 20, background: T.border, margin: "0 6px" }} />
                {studyDirection === "en-pt" && speakBtn}
                {onSuspend && (
                  <button onClick={() => onSuspend(card.id)} aria-label={t.suspend} title={t.suspend}
                    style={circleIconStyle} onMouseEnter={onCircleEnter} onMouseLeave={onCircleLeave}>
                    <SuspendIcon size={15} color={T.textSecondary} />
                  </button>
                )}
                {onUpdate && (
                  <button onClick={startEdit} aria-label="Edit card"
                    style={circleIconStyle} onMouseEnter={onCircleEnter} onMouseLeave={onCircleLeave}>
                    <PencilIcon size={14} color={T.textSecondary} />
                  </button>
                )}
                {timerBtn}
              </>
            )}
          </div>
          {/* Mid slot: input (type/question) | drawing canvas (write) | answer comparison (type/answer) — same vertical position */}
          <div style={{
            maxWidth: mobile ? "100%" : 900, margin: "0 auto",
            padding: mobile ? "0 16px" : 0,
            minHeight: answerMode === "write" ? undefined : 64,
          }}>
            {answerMode === "type" && !hasRevealed && (
              <textarea
                rows={1}
                value={userAnswer}
                onChange={(e) => setUserAnswer(e.target.value)}
                onInput={(e) => { e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && userAnswer.trim()) { e.preventDefault(); handleCheck(e); } }}
                placeholder={studyDirection === "en-pt" ? t.typeAnswerPt : t.typeAnswerEn}
                autoFocus
                name="answer"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                style={{
                  width: "100%", minHeight: 64, padding: "20px 28px", boxSizing: "border-box",
                  background: T.bgInput,
                  border: `1px solid ${T.border}`,
                  borderRadius: 14, color: T.text,
                  fontFamily: font.serif, fontSize: mobile ? 17 : 19,
                  fontWeight: 400, fontStyle: "italic",
                  outline: "none", resize: "none", overflow: "hidden",
                  transition: "border-color 0.2s",
                }}
                onFocus={(e) => { e.target.style.borderColor = T.borderStrong; }}
                onBlur={(e) => { e.target.style.borderColor = T.border; }}
              />
            )}
            {answerMode === "write" && (
              <>
                {hasRevealed && (
                  <div style={{ fontFamily: font.mono, fontSize: 10, color: T.textTertiary, textTransform: "uppercase", letterSpacing: 2, marginBottom: 6 }}>
                    {t.yourAnswer}
                  </div>
                )}
                <DrawingCanvas ref={drawRef} height={mobile ? 160 : 200} onDrawingChange={setHasDrawing} />
              </>
            )}
            {answerMode === "type" && hasRevealed && score !== null && (
              <div style={{
                minHeight: 64, padding: "20px 28px",
                background: T.bgInput,
                border: `1px solid ${T.border}`,
                borderRadius: 14,
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16,
              }}>
                <span style={{
                  fontFamily: font.serif, fontSize: mobile ? 17 : 19,
                  fontStyle: "italic", fontWeight: 400, color: T.text,
                  flex: 1,
                  lineHeight: 1.3, wordBreak: "break-word",
                }}>
                  {userAnswer}
                </span>
                <span style={{
                  fontFamily: font.mono, fontSize: mobile ? 13 : 14, fontWeight: 600,
                  color: score >= 90 ? T.success : score >= 70 ? T.warning : T.danger,
                  fontVariantNumeric: "tabular-nums", flexShrink: 0,
                }}>
                  {score}%
                </span>
              </div>
            )}
          </div>
          {/* Bottom slot: verify (question) OR rating buttons (answer) */}
          <div style={{
            maxWidth: mobile ? "100%" : 900, margin: mobile ? "12px auto 0" : (hasRevealed ? "12px auto 0" : "28px auto 0"),
            padding: mobile ? "0 16px" : 0,
          }}>
            {!hasRevealed && (() => {
              // Type mode: disabled until the user types something, then handleCheck scores + reveals.
              // Write mode: disabled until the user has drawn something, then reveals the answer (no auto-scoring).
              const verifyDisabled = answerMode === "type"
                ? !userAnswer.trim()
                : !hasDrawing;
              const onVerify = answerMode === "type"
                ? handleCheck
                : () => { stopPT(); setIsSpeaking(false); setFlipped(true); setHasRevealed(true); };
              return (
                <div style={{ textAlign: "center" }}>
                  <button
                    onClick={onVerify}
                    disabled={verifyDisabled}
                    style={{
                      height: 48, padding: "0 32px",
                      background: verifyDisabled ? "transparent" : T.accent,
                      border: verifyDisabled ? `1px solid ${T.border}` : "none",
                      borderRadius: 9999,
                      color: verifyDisabled ? T.textPlaceholder : T.bg,
                      fontFamily: font.body, fontSize: mobile ? 11 : 12, fontWeight: 500,
                      cursor: verifyDisabled ? "default" : "pointer",
                      letterSpacing: 2.5, textTransform: "uppercase",
                      transition: "all 0.15s",
                      display: "inline-flex", alignItems: "center", gap: 10,
                    }}
                    onMouseEnter={(e) => { if (!verifyDisabled) e.currentTarget.style.opacity = "0.88"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
                  >
                    {t.check}
                    <span style={{ fontSize: 14, lineHeight: 1, letterSpacing: 0 }}>→</span>
                  </button>
                </div>
              );
            })()}
            {hasRevealed && (
              <>
                {/* Grades: 2×2 on mobile, one row of four on desktop */}
                <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr 1fr" : "repeat(4, 1fr)", gap: mobile ? 8 : 12 }}>
                  {qualityButtons.filter((b) => b.q !== 0).map(renderQualityBtn)}
                </div>
                {/* Skip as a slim secondary action below */}
                {renderSkipBtn()}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
// ─── Word Row ───
const WordRow = memo(function WordRow({ card, onDelete, onSpeak, onUpdate, onTogglePriority, onSuspend, onUnsuspend }) {
  const mobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const isOverdue = card.dueDate <= today();
  const daysUntil = Math.ceil((new Date(card.dueDate) - new Date(today())) / 86400000);
  const dueLabel = (() => {
    if (card.reps === 0) return t.newCard;
    if (daysUntil === 0) return t.today;
    const d = new Date(card.dueDate + "T12:00:00");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  })();
  const lastStudiedLabel = card.lastReview
    ? (() => {
        const d = new Date(card.lastReview + "T12:00:00");
        return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
      })()
    : "—";
  const isNew = card.reps === 0;
  const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const toEnHtml = () => escHtml(card.translation || "");
  const toPtHtml = () => {
    const existingSpans = getKeywordSpans(card);
    if (card.phrase && existingSpans.length > 0) {
      return phraseToHtml(card.phrase, existingSpans, escHtml);
    }
    return escHtml(card.word || "");
  };
  const commitEn = (html) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    const newTranslation = tmp.textContent || "";
    if (newTranslation !== card.translation) {
      onUpdate(card.id, { ...card, translation: newTranslation });
    }
  };
  const commitPt = (html) => {
    const { plain, spans, kwTexts } = parseHtmlBold(html);
    const updated = { ...card };
    if (spans.length > 0) {
      updated.phrase = plain;
      updated.word = kwTexts.join(" | ");
      updated.keywordSpans = spans;
      updated.keywordStart = spans[0][0];
      updated.keywordEnd = spans[0][1];
    } else {
      updated.word = plain;
      updated.phrase = "";
      updated.keywordSpans = [];
      updated.keywordStart = 0;
      updated.keywordEnd = 0;
    }
    if (updated.word !== card.word || updated.phrase !== card.phrase || updated.translation !== card.translation ||
        JSON.stringify(updated.keywordSpans) !== JSON.stringify(card.keywordSpans)) {
      onUpdate(card.id, updated);
    }
  };
  const cellStyle = {
    padding: "6px 8px",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 4,
    color: T.text,
    fontFamily: font.body,
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.15s, background 0.15s",
    lineHeight: 1.5,
    minHeight: 28,
    wordBreak: "break-word",
    whiteSpace: "pre-wrap",
  };
  if (mobile) {
    const stage = card.suspended ? "suspended" : getStage(card);
    const sc = stageColors[stage];
    const isDark = T.bg === "#0E0E0E";
    return (
      <div
        style={{
          padding: "22px 20px",
          borderBottom: `1px solid ${T.border}`,
          position: "relative",
          contentVisibility: menuOpen ? "visible" : "auto",
          containIntrinsicSize: "auto 124px",
          zIndex: menuOpen ? 20 : "auto",
          display: "flex", flexDirection: "column", gap: 12,
        }}
      >
        {/* Top row: status badge + dates (left) · more menu (right) */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, minWidth: 0 }}>
            <span style={{
              fontFamily: font.mono, fontSize: 9, padding: "3px 9px", borderRadius: 20, letterSpacing: 0.5, whiteSpace: "nowrap",
              background: sc.bg, color: isDark ? sc.darkText : sc.text,
            }}>
              {stageLabel(stage)}
            </span>
          </div>
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              style={{
                background: "none", border: "none", cursor: "pointer", padding: "4px 6px",
                borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill={T.textSecondary}>
                <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
              </svg>
            </button>
            {menuOpen && (
              <>
                <div onClick={() => setMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 9 }} />
                <div style={{
                  position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 10,
                  background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                  boxShadow: T.shadowLg, overflow: "hidden", minWidth: 180, whiteSpace: "nowrap",
                }}>
                  <button
                    onClick={() => { onSpeak(card.phrase || card.word); setMenuOpen(false); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px",
                      background: "none", border: "none", cursor: "pointer",
                      fontFamily: font.body, fontSize: 13, color: T.textSecondary, textAlign: "left",
                    }}
                  >
                    <SpeakerIcon size={14} color={T.textTertiary} />
                    {t.listenPronunciation}
                  </button>
                  {isNew && onTogglePriority && (
                    <button
                      onClick={() => { onTogglePriority(card.id); setMenuOpen(false); }}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px",
                        background: "none", border: "none", cursor: "pointer",
                        fontFamily: font.body, fontSize: 13, color: T.textSecondary, textAlign: "left",
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.textTertiary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                      </svg>
                      {card.priority ? t.removePriority : t.addPriority}
                    </button>
                  )}
                  {card.suspended ? (
                    onUnsuspend && (
                      <button
                        onClick={() => { onUnsuspend(card.id); setMenuOpen(false); }}
                        style={{
                          display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px",
                          background: "none", border: "none", cursor: "pointer",
                          fontFamily: font.body, fontSize: 13, color: T.textSecondary, textAlign: "left",
                        }}
                      >
                        <UnsuspendIcon size={14} color={T.textTertiary} />
                        {t.unsuspend}
                      </button>
                    )
                  ) : (
                    onSuspend && (
                      <button
                        onClick={() => { onSuspend(card.id); setMenuOpen(false); }}
                        style={{
                          display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px",
                          background: "none", border: "none", cursor: "pointer",
                          fontFamily: font.body, fontSize: 13, color: T.textSecondary, textAlign: "left",
                        }}
                      >
                        <SuspendIcon size={14} color={T.textTertiary} />
                        {t.suspend}
                      </button>
                    )
                  )}
                  <button
                    onClick={() => { onDelete(card.id); setMenuOpen(false); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px",
                      background: "none", border: "none", cursor: "pointer",
                      fontFamily: font.body, fontSize: 13, color: T.danger, textAlign: "left",
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.danger} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                    {t.deleteWord}
                  </button>
                </div>
              </>
              )}
            </div>
          </div>
        {/* English on its own row */}
        <span style={{ fontFamily: font.body, fontSize: 16, fontWeight: 500, color: T.text, wordBreak: "break-word", lineHeight: 1.45 }}>
          {card.translation}
        </span>
        {/* Portuguese on its own row */}
        <div style={{ fontFamily: font.body, fontSize: 16, color: T.textSecondary, wordBreak: "break-word", lineHeight: 1.45 }}>
          {card.phrase
            ? <PhraseDisplay phrase={card.phrase} spans={card.keywordSpans} keywordStart={card.keywordStart} keywordEnd={card.keywordEnd} size="small" fontSize={16} />
            : card.word}
        </div>
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 90px 90px 90px 32px",
        gap: 12,
        alignItems: "start",
        padding: "10px 20px",
        borderBottom: `1px solid ${T.border}`,
        transition: "background 0.12s",
        contentVisibility: menuOpen ? "visible" : "auto",
        containIntrinsicSize: "auto 48px",
        position: "relative",
        zIndex: menuOpen ? 20 : "auto",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = T.bgCardHover)}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; setMenuOpen(false); }}
    >
      <EditableCell html={toEnHtml()} onCommit={commitEn} style={cellStyle} />
      <EditableCell html={toPtHtml()} onCommit={commitPt} style={cellStyle} />
      {(() => {
        const stage = card.suspended ? "suspended" : getStage(card);
        const sc = stageColors[stage];
        const isDark = T.bg === "#0E0E0E";
        return (
          <div style={{ display: "flex", justifyContent: "flex-start", paddingTop: 4 }}>
            <span style={{
              fontFamily: font.mono, fontSize: 10, padding: "4px 10px", borderRadius: 20, letterSpacing: 0.5, whiteSpace: "nowrap",
              background: sc.bg, color: isDark ? sc.darkText : sc.text,
            }}>
              {stageLabel(stage)}
            </span>
          </div>
        );
      })()}
      <div style={{ display: "flex", justifyContent: "flex-start", paddingTop: 4 }}>
        {(() => {
          const isDark = T.bg === "#0E0E0E";
          const newSc = stageColors.new;
          const showPriority = isNew && card.priority;
          return (
            <span style={{
              fontFamily: font.mono, fontSize: 10, padding: "4px 10px", borderRadius: 20, letterSpacing: 0.5, whiteSpace: "nowrap",
              background: showPriority ? T.borderStrong : (isNew ? newSc.bg : (isOverdue ? T.dangerBg : T.accentSoft)),
              color: showPriority ? T.text : (isNew ? (isDark ? newSc.darkText : newSc.text) : (isOverdue ? T.danger : T.textTertiary)),
              fontWeight: 400,
            }}>
              {showPriority ? t.upNext : (isNew ? t.notAvailable : dueLabel)}
            </span>
          );
        })()}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-start", alignItems: "center", paddingTop: 4 }}>
        <span style={{
          fontFamily: font.mono, fontSize: 11, color: T.textTertiary,
          whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
        }}>
          {lastStudiedLabel}
        </span>
      </div>
      <div style={{ position: "relative", paddingTop: 4 }}>
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          style={{
            background: "none", border: "none", cursor: "pointer", padding: "4px 6px",
            borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center",
            opacity: 0.7, transition: "opacity 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = 1)}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = 0.7)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={T.textSecondary}>
            <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
          </svg>
        </button>
        {menuOpen && (
          <div style={{
            position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 10,
            background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
            boxShadow: T.shadowLg, overflow: "hidden", minWidth: 180, whiteSpace: "nowrap",
          }}>
            <button
              onClick={() => { onSpeak(card.phrase || card.word); setMenuOpen(false); }}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px",
                background: "none", border: "none", cursor: "pointer",
                fontFamily: font.body, fontSize: 13, color: T.textSecondary, textAlign: "left",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = T.bgCardHover)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            >
              <SpeakerIcon size={14} color={T.textTertiary} />
              {t.listenPronunciation}
            </button>
            {isNew && onTogglePriority && (
              <button
                onClick={() => { onTogglePriority(card.id); setMenuOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px",
                  background: "none", border: "none", cursor: "pointer",
                  fontFamily: font.body, fontSize: 13, color: T.textSecondary, textAlign: "left",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = T.bgCardHover)}
                onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={card.priority ? T.accent : T.textTertiary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
                {card.priority ? t.removePriority : t.addPriority}
              </button>
            )}
            {card.suspended ? (
              onUnsuspend && (
                <button
                  onClick={() => { onUnsuspend(card.id); setMenuOpen(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px",
                    background: "none", border: "none", cursor: "pointer",
                    fontFamily: font.body, fontSize: 13, color: T.textSecondary, textAlign: "left",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = T.bgCardHover)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                >
                  <UnsuspendIcon size={14} color={T.textTertiary} />
                  {t.unsuspend}
                </button>
              )
            ) : (
              onSuspend && (
                <button
                  onClick={() => { onSuspend(card.id); setMenuOpen(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px",
                    background: "none", border: "none", cursor: "pointer",
                    fontFamily: font.body, fontSize: 13, color: T.textSecondary, textAlign: "left",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = T.bgCardHover)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                >
                  <SuspendIcon size={14} color={T.textTertiary} />
                  {t.suspend}
                </button>
              )
            )}
            <button
              onClick={() => { onDelete(card.id); setMenuOpen(false); }}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 14px",
                background: "none", border: "none", cursor: "pointer",
                fontFamily: font.body, fontSize: 13, color: T.danger, textAlign: "left",
                transition: "background 0.1s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = T.dangerBg)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.danger} strokeWidth="1.8" strokeLinecap="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
              {t.deleteWord}
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
const iconBtnStyle = { background: "none", border: "none", cursor: "pointer", padding: 6, borderRadius: 9999, display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.5, transition: "opacity 0.15s" };
// ─── Full Page Modal ───
function Modal({ open, onClose, title, children }) {
  const mobile = useIsMobile();
  if (!open) return null;
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      background: T.bg,
      overflow: "auto",
    }}>
      <button
        onClick={onClose}
        style={{
          position: "fixed", top: mobile ? 12 : 20, right: mobile ? 12 : `max(20px, calc((100vw - 1200px) / 2 + 36px))`, zIndex: 110,
          width: 44, height: 44, borderRadius: 9999,
          background: T.bgCard,
          border: `1px solid ${T.border}`,
          boxShadow: T.shadowLg,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer",
          transition: "transform 0.15s, box-shadow 0.15s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.05)"; e.currentTarget.style.boxShadow = T.shadowLg; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={T.text} strokeWidth="2" strokeLinecap="round">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
      <div style={{ padding: mobile ? "20px 16px 60px" : "36px 36px 60px", maxWidth: 1200, margin: "0 auto" }}>
        {title && (
          <div style={{ fontFamily: font.display, fontSize: mobile ? 20 : 24, fontWeight: 700, color: T.text, marginBottom: mobile ? 20 : 28, textTransform: "capitalize" }}>
            {title}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
// ─── Editable Cell (ref-based, no cursor jumping) ───
function EditableCell({ html, onCommit, style }) {
  const ref = useRef(null);
  const initialHtml = useRef(html);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (document.activeElement === el) return;
    if (el.innerHTML !== html) {
      el.innerHTML = html;
    }
  }, [html]);
  useEffect(() => {
    if (ref.current) {
      ref.current.innerHTML = initialHtml.current;
    }
  }, []);
  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onFocus={(e) => {
        e.currentTarget.style.borderColor = T.borderStrong;
        e.currentTarget.style.background = T.bgInput;
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = "transparent";
        e.currentTarget.style.background = "transparent";
        onCommit(e.currentTarget.innerHTML);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      style={style}
    />
  );
}
// ─── Import Panel ───
function ImportPanel({ onImport, existingCount }) {
  const mobile = useIsMobile();
  const [text, setText] = useState("");
  const [results, setResults] = useState([]);
  const [errors, setErrors] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [importedCount, setImportedCount] = useState(0);
  const [fileLoaded, setFileLoaded] = useState(false);
  const fileRef = useRef(null);
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const handleTextChange = (val) => {
    setText(val);
    setImportedCount(0);
    if (val.trim()) {
      const parsed = parseImportText(val);
      setErrors(parsed.errors);
      setResults((prev) => {
        return parsed.results.map((newR, i) => {
          if (i < prev.length && prev[i]._srcLine === newR._srcLine) {
            return prev[i];
          }
          return newR;
        });
      });
      setSelected((prevSel) => {
        const prev = resultsRef.current;
        const next = new Set();
        parsed.results.forEach((newR, i) => {
          if (i < prev.length && prev[i]._srcLine === newR._srcLine) {
            if (prevSel.has(i)) next.add(i);
          } else {
            next.add(i);
          }
        });
        return next;
      });
    } else {
      setResults([]);
      setErrors([]);
      setSelected(new Set());
    }
  };
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setFileLoaded(true);
      handleTextChange(ev.target.result);
    };
    reader.readAsText(file);
  };
  const toggleItem = (i) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(results.map((_, i) => i)));
  const deselectAll = () => setSelected(new Set());
  const allSelected = results.length > 0 && selected.size === results.length;
  const someSelected = selected.size > 0 && !allSelected;
  const toHtml = (r, field) => {
    if (field === "translation") return escHtml(r.translation);
    if (field === "portuguese") {
      if (r.phrase && r.keywordStart !== undefined && r.keywordEnd !== undefined && r.keywordStart !== r.keywordEnd) {
        const before = r.phrase.slice(0, r.keywordStart);
        const kw = r.phrase.slice(r.keywordStart, r.keywordEnd);
        const after = r.phrase.slice(r.keywordEnd);
        return escHtml(before) + "<b>" + escHtml(kw) + "</b>" + escHtml(after);
      }
      return escHtml(r.word || "");
    }
    return "";
  };
  const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const commitCell = (i, field, html) => {
    setResults((prev) => {
      const next = [...prev];
      const item = { ...next[i] };
      if (field === "translation") {
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        item.translation = tmp.textContent || "";
      } else if (field === "portuguese") {
        const { plain, kwStart, kwEnd, kwText } = parseHtmlBold(html);
        if (kwStart !== null && kwEnd !== null && kwText) {
          item.phrase = plain;
          item.word = kwText;
          item.keywordStart = kwStart;
          item.keywordEnd = kwEnd;
        } else {
          item.word = plain;
          item.phrase = "";
          item.keywordStart = 0;
          item.keywordEnd = 0;
        }
      }
      next[i] = item;
      return next;
    });
  };
  const handleImport = () => {
    if (selected.size === 0) return;
    const count = selected.size;
    const newCards = results
      .filter((_, i) => selected.has(i))
      .map((r) => FSRS.defaultCard(r.word, r.translation, r.phrase, r.keywordStart, r.keywordEnd));
    onImport(newCards);
    setText("");
    setResults([]);
    setErrors([]);
    setSelected(new Set());
    setImportedCount(count);
    setFileLoaded(false);
  };
  const inputStyle = {
    width: "100%",
    padding: "14px 16px",
    background: T.bgInput,
    border: "1px solid transparent",
    borderRadius: T.radiusSm,
    color: T.text,
    fontFamily: font.mono,
    fontSize: 13,
    outline: "none",
    transition: "border-color 0.2s, box-shadow 0.2s",
    boxSizing: "border-box",
    lineHeight: 1.7,
    minHeight: 180,
    resize: "vertical",
  };
  const cellStyle = {
    width: "100%",
    padding: "6px 8px",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 4,
    color: T.text,
    fontFamily: font.body,
    fontSize: 13,
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.15s, background 0.15s",
    lineHeight: 1.5,
    minHeight: 28,
    wordBreak: "break-word",
    whiteSpace: "pre-wrap",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {!fileLoaded && (
        <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: 28, boxShadow: T.shadow }}>
          <div style={{ fontFamily: font.body, fontSize: 14, color: T.textSecondary, lineHeight: 1.7, marginBottom: 20 }}>
            {t.importDesc}
          </div>
          <input ref={fileRef} type="file" accept=".md,.csv,.txt,.tsv" onChange={handleFileUpload} style={{ display: "none" }} />
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <button
              onClick={() => fileRef.current?.click()}
              style={{
                padding: "10px 20px", background: "none", border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                color: T.textSecondary, fontFamily: font.body, fontSize: 13, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 8, transition: "all 0.15s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "none"; }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.textSecondary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              carregar arquivo
            </button>
            <span style={{ fontFamily: font.mono, fontSize: 11, color: T.textTertiary, alignSelf: "center" }}>.md, .csv, .txt</span>
          </div>
          <textarea
            style={inputStyle}
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            placeholder={t.pasteHere}
            onFocus={(e) => { e.target.style.borderColor = T.borderStrong; e.target.style.boxShadow = "0 0 0 3px rgba(0,0,0,0.03)"; }}
            onBlur={(e) => { e.target.style.borderColor = "transparent"; e.target.style.boxShadow = "none"; }}
          />
        </div>
      )}
      {fileLoaded && results.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: T.keywordBg, border: `1px solid rgba(45,106,79,0.15)`, borderRadius: T.radiusSm, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.success} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <span style={{ fontFamily: font.body, fontSize: 13, color: T.success, fontWeight: 500 }}>
              {results.length} {results.length === 1 ? t.word : t.wordsPlural} encontradas no arquivo
            </span>
          </div>
          <button
            onClick={() => { setFileLoaded(false); setText(""); setResults([]); setErrors([]); setSelected(new Set()); if (fileRef.current) fileRef.current.value = ""; }}
            style={{ background: "none", border: "none", cursor: "pointer", fontFamily: font.body, fontSize: 12, color: T.textTertiary, padding: "4px 8px", borderRadius: 6, transition: "color 0.15s" }}
            onMouseEnter={(e) => e.currentTarget.style.color = T.text}
            onMouseLeave={(e) => e.currentTarget.style.color = T.textTertiary}
          >
            {t.cancel}
          </button>
        </div>
      )}
      {results.length > 0 && (
        <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, overflow: "hidden", boxShadow: T.shadow }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 20px", borderBottom: `1px solid ${T.border}` }}>
            <span style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary }}>
              {selected.size} {t.selectedOf} {results.length} {t.selected}
            </span>
            <button
              onClick={handleImport}
              disabled={selected.size === 0}
              style={{
                padding: "9px 22px",
                background: selected.size > 0 ? T.accent : T.bgInput,
                border: "none", borderRadius: T.radiusSm,
                color: selected.size > 0 ? T.bg : T.textPlaceholder,
                fontFamily: font.body, fontSize: 13, fontWeight: 600,
                cursor: selected.size > 0 ? "pointer" : "default",
                letterSpacing: 0.3, transition: "all 0.15s",
              }}
              onMouseEnter={(e) => { if (selected.size > 0) e.currentTarget.style.opacity = "0.85"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
            >
              {t.add} {selected.size} {selected.size === 1 ? t.word : t.wordsPlural}
            </button>
          </div>
          <div style={{ display: mobile ? "none" : "grid", gridTemplateColumns: "40px 1fr 1fr 2fr", gap: 12, padding: "10px 20px", borderBottom: `1px solid ${T.border}`, background: T.bgCardHover }}>
            <div
              onClick={allSelected ? deselectAll : selectAll}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
              onMouseEnter={(e) => { const c = e.currentTarget.firstChild; if (c) c.style.borderColor = T.borderStrong; }}
              onMouseLeave={(e) => { const c = e.currentTarget.firstChild; if (c) c.style.borderColor = allSelected || someSelected ? T.success : T.borderStrong; }}
            >
              <div style={{
                width: 18, height: 18, borderRadius: 4,
                border: `1.5px solid ${allSelected || someSelected ? T.success : T.borderStrong}`,
                background: allSelected ? T.keywordBg : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "all 0.15s", flexShrink: 0, position: "relative",
              }}>
                {allSelected && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={T.success} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
                {someSelected && !allSelected && (
                  <div style={{ width: 8, height: 2, background: T.success, borderRadius: 1 }} />
                )}
              </div>
            </div>
            {[t.headerPalavra, t.headerEnglish, t.headerPortuguese].map((h, i) => (
              <span key={i} style={{ fontFamily: font.mono, fontSize: 9, color: T.textTertiary, textTransform: "uppercase", letterSpacing: 2 }}>{h}</span>
            ))}
          </div>
          {results.map((r, i) => {
            const isSelected = selected.has(i);
            return (
              <div
                key={i}
                style={mobile ? {
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 16px",
                  borderBottom: i < results.length - 1 ? `1px solid ${T.border}` : "none",
                  opacity: isSelected ? 1 : 0.4,
                  background: isSelected ? "transparent" : T.bgCardHover,
                } : {
                  display: "grid",
                  gridTemplateColumns: "40px 1fr 1fr 2fr",
                  gap: 12,
                  alignItems: "start",
                  padding: "10px 20px",
                  borderBottom: i < results.length - 1 ? `1px solid ${T.border}` : "none",
                  transition: "background 0.12s",
                  opacity: isSelected ? 1 : 0.4,
                  background: isSelected ? "transparent" : T.bgCardHover,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = T.bgCardHover; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = isSelected ? "transparent" : T.bgCardHover; }}
              >
                <div
                  onClick={() => toggleItem(i)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", paddingTop: 4, flexShrink: 0 }}
                >
                  <div style={{
                    width: 22, height: 22, borderRadius: 6,
                    border: `1.5px solid ${isSelected ? T.success : T.border}`,
                    background: isSelected ? T.keywordBg : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    transition: "all 0.15s",
                  }}>
                    {isSelected && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={T.success} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                  </div>
                </div>
                {mobile ? (
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 700, color: T.keyword, wordBreak: "break-word" }}>{r.word}</div>
                    <div style={{ fontFamily: font.body, fontSize: 13, color: T.textSecondary, marginTop: 2, wordBreak: "break-word" }}>{r.translation}</div>
                    {r.phrase && <div style={{ fontFamily: font.body, fontSize: 12, color: T.textTertiary, marginTop: 2, wordBreak: "break-word" }}>{r.phrase}</div>}
                  </div>
                ) : (
                  <>
                    <span style={{ fontFamily: font.body, fontSize: 14, fontWeight: 700, color: T.keyword, padding: "6px 0", wordBreak: "break-word" }}>{r.word}</span>
                    <EditableCell html={toHtml(r, "translation")} onCommit={(html) => commitCell(i, "translation", html)} style={cellStyle} />
                    <EditableCell html={toHtml(r, "portuguese")} onCommit={(html) => commitCell(i, "portuguese", html)} style={cellStyle} />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {errors.length > 0 && (
        <div style={{ background: T.warningBg, border: `1px solid rgba(181,134,11,0.12)`, borderRadius: T.radius, padding: 20 }}>
          <div style={{ fontFamily: font.mono, fontSize: 10, color: T.warning, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
            {errors.length} {t.linesNotRecognized}
          </div>
          {errors.slice(0, 5).map((err, i) => (
            <div key={i} style={{ fontFamily: font.mono, fontSize: 11, color: T.textSecondary, lineHeight: 1.8 }}>
              <span style={{ color: T.textTertiary }}>linha {err.line}:</span> {err.text.substring(0, 60)}{err.text.length > 60 ? "..." : ""}
            </div>
          ))}
        </div>
      )}
      {results.length === 0 && text.trim() && (
        <div style={{ background: T.dangerBg, border: `1px solid rgba(196,72,62,0.12)`, borderRadius: T.radius, padding: 24, textAlign: "center" }}>
          <div style={{ fontFamily: font.body, fontSize: 14, color: T.danger, marginBottom: 4 }}>
            nenhuma palavra reconhecida
          </div>
          <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary }}>
            verifique se o formato está correto — use &lt;&gt; , ↔ , == ou vírgula como separador
          </div>
        </div>
      )}
      {importedCount > 0 && results.length === 0 && (
        <div style={{ background: T.keywordBg, border: `1px solid rgba(45,106,79,0.15)`, borderRadius: T.radius, padding: 20, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 16, background: T.success,
            display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.bg} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div>
            <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text }}>
              {importedCount} {importedCount === 1 ? t.word + " " + t.importedSuccessSingular : t.wordsPlural + " " + t.importedSuccess}
            </div>
            <div style={{ fontFamily: font.body, fontSize: 13, color: T.textSecondary, marginTop: 2 }}>
              {t.goToWords}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
// ─── Google Sheets Sync (via Apps Script proxy) ───
const GSheets = {
  // Read all cards from the sheet
  readCards: async (scriptUrl) => {
    const res = await fetch(`${scriptUrl}?action=readCards`);
    if (!res.ok) throw new Error(`Sync read failed: ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return (data.cards || []).map(c => ({
      ...c,
      keywordStart: Number(c.keywordStart) || 0,
      keywordEnd: Number(c.keywordEnd) || 0,
      stability: Number(c.stability) || 0,
      difficulty: Number(c.difficulty) || 0,
      reps: Number(c.reps) || 0,
      dueDate: normalizeDate(c.dueDate) || today(),
      lastReview: normalizeDate(c.lastReview) || null,
      created: normalizeDate(c.created) || today(),
      modifiedAt: Number(c.modifiedAt) || 0,
    }));
  },
  // Read practice days + deleted cards metadata
  readMeta: async (scriptUrl) => {
    const res = await fetch(`${scriptUrl}?action=readMeta`);
    if (!res.ok) return { practiceDays: {}, deletedCards: {} };
    const data = await res.json();
    if (data.error) return { practiceDays: {}, deletedCards: {} };
    let practiceDays = {};
    let deletedCards = {};
    try { practiceDays = JSON.parse(data.practiceDays || "{}"); } catch {}
    try { deletedCards = JSON.parse(data.deletedCards || "{}"); } catch {}
    return { practiceDays, deletedCards };
  },
  // Write all cards (full overwrite)
  writeCards: async (scriptUrl, cards) => {
    const res = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "writeCards", cards }),
    });
    if (!res.ok) throw new Error(`Sync write failed: ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
  },
  // Write practice days + deleted cards metadata
  writeMeta: async (scriptUrl, practiceDays, deletedCards) => {
    const res = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        action: "writeMeta",
        practiceDays: JSON.stringify(practiceDays),
        deletedCards: JSON.stringify(deletedCards || {}),
      }),
    });
    if (!res.ok) throw new Error(`Sync meta-write failed: ${res.status}`);
    try {
      const data = await res.json();
      if (data && data.error) throw new Error(data.error);
    } catch (e) {
      // Response wasn't JSON; if status was ok, treat as success
      if (e.message && e.message.startsWith("Sync meta-write")) throw e;
    }
  },
  // Snapshot — append a JSON snapshot row to the "Backups" tab
  writeSnapshot: async (scriptUrl, snapshot) => {
    const res = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "writeSnapshot", snapshot }),
    });
    if (!res.ok) throw new Error(`Snapshot write failed: ${res.status}`);
    const data = await res.json().catch(() => ({}));
    if (data && data.error) throw new Error(data.error);
  },
  // List snapshots — returns [{ date, size }, ...] newest-first
  listSnapshots: async (scriptUrl) => {
    const res = await fetch(`${scriptUrl}?action=listSnapshots`);
    if (!res.ok) throw new Error(`Snapshot list failed: ${res.status}`);
    const data = await res.json();
    if (data && data.error) throw new Error(data.error);
    return (data.snapshots || []).slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  },
  // Read a single snapshot by date string
  readSnapshot: async (scriptUrl, date) => {
    const res = await fetch(`${scriptUrl}?action=readSnapshot&date=${encodeURIComponent(date)}`);
    if (!res.ok) throw new Error(`Snapshot read failed: ${res.status}`);
    const data = await res.json();
    if (data && data.error) throw new Error(data.error);
    return data.snapshot || null;
  },
};
// ─── Merge Logic ───
// ─── Main App ───
export default function VocabApp() {
  const mobile = useIsMobile();
  const [cards, setCards] = useState([]);
  const [practiceDays, setPracticeDays] = useState({});
  const [studyTime, setStudyTime] = useState({}); // { "YYYY-MM-DD": seconds }
  const [activeSession, setActiveSession] = useState(null); // { startedAt, lastSeenAt, accumulatedSec } | null
  const [liveElapsed, setLiveElapsed] = useState(0);
  const [timerToast, setTimerToast] = useState(null); // { message }
  const [view, setView] = useState("practice");
  const [loaded, setLoaded] = useState(false);
  const [heatmapYear, setHeatmapYear] = useState(new Date().getFullYear());
  const [studyTimePeriod, setStudyTimePeriod] = useState("week");
  const [showAddInline, setShowAddInline] = useState(false);
  const [showImportInline, setShowImportInline] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showStudyTimeEditModal, setShowStudyTimeEditModal] = useState(false);
  const [lastManualBackup, setLastManualBackup] = useState(() => {
    try { return Number(localStorage.getItem("vocab-last-manual-backup")) || 0; } catch { return 0; }
  });
  const [lastAutoSnapshot, setLastAutoSnapshot] = useState(() => {
    try { return Number(localStorage.getItem("vocab-last-snapshot")) || 0; } catch { return 0; }
  });
  const [backupToast, setBackupToast] = useState(null);
  const [showSnapshotPicker, setShowSnapshotPicker] = useState(false);
  const [snapshotList, setSnapshotList] = useState(null); // null = not loaded, [] = empty, [...] = loaded
  const [snapshotListError, setSnapshotListError] = useState("");
  const importFileRef = useRef(null);
  const [deletedCards, setDeletedCards] = useState({});
  const [sortKey, setSortKey] = useState("added");
  const [sortDir, setSortDir] = useState("desc");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [groupByStage, setGroupByStage] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());
  const toggleGroup = (stage) => setCollapsedGroups(prev => {
    const next = new Set(prev);
    next.has(stage) ? next.delete(stage) : next.add(stage);
    return next;
  });
  const [activityRange, setActivityRange] = useState("month");
  const [studyDirection, setStudyDirection] = useState("en-pt");
  const [answerMode, setAnswerMode] = useState("type");
  const [settings, setSettings] = useState({
    theme: "light",
    dailyGoal: 20,
    newCardsPerDay: 10,
    cardOrder: "due",
    lang: "pt-BR",
    apiKey: "",
    scriptUrl: DEFAULT_SCRIPT_URL,
  });
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [scriptUrlInput, setScriptUrlInput] = useState(DEFAULT_SCRIPT_URL);
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncError, setSyncError] = useState("");
  const [lastSynced, setLastSynced] = useState(null);
  const [sheetsSaved, setSheetsSaved] = useState(false);
  const dirtyRef = useRef(false);
  const syncTimerRef = useRef(null);
  const syncInFlightRef = useRef(false);
  const syncRerunRef = useRef(false);
  const cardsRef = useRef(cards);
  const practiceDaysRef = useRef(practiceDays);
  const deletedCardsRef = useRef(deletedCards);
  useEffect(() => { cardsRef.current = cards; }, [cards]);
  useEffect(() => { practiceDaysRef.current = practiceDays; }, [practiceDays]);
  useEffect(() => { deletedCardsRef.current = deletedCards; }, [deletedCards]);
  // Lock the practice screen in place on mobile so the keyboard can't shove the
  // header/content around — everything stays put, no scrolling. The words and
  // progress views still scroll normally.
  useEffect(() => {
    if (!mobile || view !== "practice") return;
    const html = document.documentElement;
    const body = document.body;
    const prev = { html: html.style.overflow, body: body.style.overflow, overscroll: body.style.overscrollBehavior };
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    return () => {
      html.style.overflow = prev.html;
      body.style.overflow = prev.body;
      body.style.overscrollBehavior = prev.overscroll;
    };
  }, [mobile, view]);
  T = themes[settings.theme] || themes.light;
  t = i18n[settings.lang] || i18n["pt-BR"];
  // Single reconcile path for every sync trigger. Two invariants make it safe to
  // run while the user is actively studying:
  //   1. It merges against the FRESHEST local state (cardsRef.current, read
  //      synchronously right before setCards with no await in between) — not a
  //      snapshot captured before the network round-trip. A review made while the
  //      read was in flight is therefore preserved instead of being reverted.
  //   2. It commits local state BEFORE writing to the sheet, so a review that
  //      lands during the remote write layers on top (and re-marks dirty for the
  //      next sync) rather than being clobbered by a late setCards.
  // An in-flight guard prevents two overlapping syncs from racing each other's
  // setCards; a coalescing rerun flag ensures the latest state still gets pushed.
  const doSync = useCallback(async (scriptUrlArg) => {
    const scriptUrl = scriptUrlArg || settings.scriptUrl;
    if (!scriptUrl) return;
    if (syncInFlightRef.current) { syncRerunRef.current = true; return; }
    syncInFlightRef.current = true;
    setSyncStatus("syncing");
    try {
      // Read remote state
      const remoteCards = await GSheets.readCards(scriptUrl);
      const remoteMeta = await GSheets.readMeta(scriptUrl);
      // Capture freshest local state synchronously — no await before setCards.
      const localCards = cardsRef.current;
      const localDays = practiceDaysRef.current;
      const localDeleted = deletedCardsRef.current;
      const { cards: mergedCards, deleted: mergedDeleted } = mergeCards(
        localCards, remoteCards, localDeleted, remoteMeta.deletedCards || {}
      );
      const mergedDays = mergePracticeDays(localDays, remoteMeta.practiceDays || {});
      // Commit locally first (see invariant 2).
      setCards(mergedCards);
      setPracticeDays(mergedDays);
      setDeletedCards(mergedDeleted);
      dirtyRef.current = false;
      window.storage.set("vocab-cards", JSON.stringify(mergedCards)).catch(() => {});
      window.storage.set("vocab-practice-days", JSON.stringify(mergedDays)).catch(() => {});
      window.storage.set("vocab-deleted", JSON.stringify(mergedDeleted)).catch(() => {});
      // Then push to the sheet.
      await GSheets.writeCards(scriptUrl, mergedCards);
      await GSheets.writeMeta(scriptUrl, mergedDays, mergedDeleted);
      setSyncStatus("synced");
      setLastSynced(new Date().toLocaleTimeString());
      setSyncError("");
    } catch (e) {
      setSyncStatus("error");
      setSyncError(e.message);
    } finally {
      syncInFlightRef.current = false;
      if (syncRerunRef.current) { syncRerunRef.current = false; doSync(scriptUrl); }
    }
  }, [settings.scriptUrl]);
  const scheduleSyncIfDirty = useCallback(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      if (dirtyRef.current && settings.scriptUrl) {
        doSync();
      }
    }, 60000);
  }, [settings.scriptUrl, doSync]);
  useEffect(() => {
    const load = async () => {
      let savedSettings = null;
      try {
        const r = await window.storage.get("vocab-settings");
        if (r) {
          savedSettings = JSON.parse(r.value);
          setSettings((prev) => ({ ...prev, ...savedSettings, scriptUrl: savedSettings.scriptUrl || DEFAULT_SCRIPT_URL }));
          if (savedSettings.apiKey) setApiKeyInput(savedSettings.apiKey);
          setScriptUrlInput(savedSettings.scriptUrl || DEFAULT_SCRIPT_URL);
        }
      } catch {}
      // Load local data
      let localCards = [];
      let localDays = {};
      let localDeleted = {};
      let localStudyTime = {};
      let localActiveSession = null;
      try { const r = await window.storage.get("vocab-cards"); if (r) localCards = JSON.parse(r.value); } catch {}
      try { const r = await window.storage.get("vocab-practice-days"); if (r) localDays = JSON.parse(r.value); } catch {}
      try { const r = await window.storage.get("vocab-deleted"); if (r) localDeleted = JSON.parse(r.value); } catch {}
      try { const r = await window.storage.get("vocab-study-time"); if (r) localStudyTime = JSON.parse(r.value); } catch {}
      try { const r = await window.storage.get("vocab-active-session"); if (r) localActiveSession = JSON.parse(r.value); } catch {}
      // Backfill day-counts for imported RemNote study days that were recorded
      // without a per-day count (stored as empty {} or missing entirely, so they
      // never showed in the "days studied" tally or the heatmap). Idempotent:
      // only fills days whose current count is 0, so it never overwrites a real
      // count and re-running is a no-op once filled.
      try {
        const tally = remnotePracticeDayTally();
        let backfilled = false;
        for (const [day, count] of Object.entries(tally)) {
          if (totalForDay(localDays[day]) === 0) {
            localDays[day] = count;
            backfilled = true;
          }
        }
        if (backfilled) {
          await window.storage.set("vocab-practice-days", JSON.stringify(localDays)).catch(() => {});
        }
      } catch {}
      // Show local data immediately
      setCards(localCards);
      setPracticeDays(localDays);
      setDeletedCards(localDeleted);
      setStudyTime(localStudyTime);
      // Recover active session (if any)
      if (localActiveSession && localActiveSession.startedAt && localActiveSession.lastSeenAt) {
        const now = Date.now();
        const gap = now - localActiveSession.lastSeenAt;
        if (gap < IDLE_CAP_MS) {
          // Continue running — count the gap as study time
          setActiveSession({
            startedAt: localActiveSession.startedAt,
            lastSeenAt: now,
            accumulatedSec: (localActiveSession.accumulatedSec || 0) + Math.floor(gap / 1000),
          });
        } else {
          // Gap too long — flush what we had and stop
          const dateKey = localDateStr(new Date(localActiveSession.lastSeenAt));
          const accumulated = Math.floor(localActiveSession.accumulatedSec || 0);
          if (accumulated > 0) {
            const nextStudyTime = { ...localStudyTime, [dateKey]: (localStudyTime[dateKey] || 0) + accumulated };
            setStudyTime(nextStudyTime);
            window.storage.set("vocab-study-time", JSON.stringify(nextStudyTime)).catch(() => {});
          }
          window.storage.set("vocab-active-session", JSON.stringify(null)).catch(() => {});
          const gapHours = Math.floor(gap / 3600000);
          const gapMins = Math.floor((gap % 3600000) / 60000);
          const awayLabel = gapHours > 0 ? `${gapHours}h ${gapMins}m` : `${gapMins}m`;
          setTimerToast({ message: `Timer auto-stopped — you were away ${awayLabel}` });
          setTimeout(() => setTimerToast(null), 6000);
        }
      }
      setLoaded(true);

      // Background sync with Google Sheets
      const sUrl = savedSettings?.scriptUrl || DEFAULT_SCRIPT_URL;
      if (sUrl) {
        setSyncStatus("syncing");
        try {
          const remoteCards = await GSheets.readCards(sUrl);
          const remoteMeta = await GSheets.readMeta(sUrl);
          const { cards: merged, deleted: mergedDel } = mergeCards(
            localCards, remoteCards, localDeleted, remoteMeta.deletedCards || {}
          );
          const mergedDays = mergePracticeDays(localDays, remoteMeta.practiceDays || {});
          setCards(merged);
          setPracticeDays(mergedDays);
          setDeletedCards(mergedDel);
          await window.storage.set("vocab-cards", JSON.stringify(merged)).catch(() => {});
          await window.storage.set("vocab-practice-days", JSON.stringify(mergedDays)).catch(() => {});
          await window.storage.set("vocab-deleted", JSON.stringify(mergedDel)).catch(() => {});
          await GSheets.writeCards(sUrl, merged);
          await GSheets.writeMeta(sUrl, mergedDays, mergedDel);
          setSyncStatus("synced");
          setLastSynced(new Date().toLocaleTimeString());
        } catch (e) {
          setSyncStatus("error");
          setSyncError(e.message);
        }
      }
    };
    load();
    if ("speechSynthesis" in window) { window.speechSynthesis.getVoices(); window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices(); }
  }, []);
  useEffect(() => {
    const flushSync = () => {
      if (dirtyRef.current && settings.scriptUrl) {
        const payload = JSON.stringify({ action: "writeCards", cards: cardsRef.current });
        navigator.sendBeacon(settings.scriptUrl, payload);
        const metaPayload = JSON.stringify({ action: "writeMeta", practiceDays: JSON.stringify(practiceDaysRef.current), deletedCards: JSON.stringify(deletedCardsRef.current) });
        navigator.sendBeacon(settings.scriptUrl, metaPayload);
        dirtyRef.current = false;
      }
    };
    const handleVisChange = () => {
      if (document.visibilityState === "hidden" && dirtyRef.current && settings.scriptUrl) {
        doSync();
      }
    };
    window.addEventListener("beforeunload", flushSync);
    document.addEventListener("visibilitychange", handleVisChange);
    return () => {
      window.removeEventListener("beforeunload", flushSync);
      document.removeEventListener("visibilitychange", handleVisChange);
    };
  }, [settings.scriptUrl, doSync]);
  const manualSync = useCallback(async () => {
    if (!settings.scriptUrl) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    await doSync();
  }, [settings.scriptUrl, doSync]);
  const save = useCallback(async (newCards, newDays) => {
    try {
      await window.storage.set("vocab-cards", JSON.stringify(newCards));
      await window.storage.set("vocab-practice-days", JSON.stringify(newDays));
    } catch (e) { console.error("Local save failed:", e); }
    if (settings.scriptUrl) {
      dirtyRef.current = true;
      scheduleSyncIfDirty();
    }
  }, [settings, scheduleSyncIfDirty]);
  const studyTimeRef = useRef(studyTime);
  const activeSessionRef = useRef(activeSession);
  useEffect(() => { studyTimeRef.current = studyTime; }, [studyTime]);
  useEffect(() => { activeSessionRef.current = activeSession; }, [activeSession]);
  const persistStudyTime = useCallback((next) => {
    window.storage.set("vocab-study-time", JSON.stringify(next)).catch(() => {});
  }, []);
  const setStudyTimeForDate = useCallback((date, seconds) => {
    setStudyTime((prev) => {
      const next = { ...prev };
      if (seconds > 0) next[date] = seconds;
      else delete next[date];
      persistStudyTime(next);
      return next;
    });
  }, [persistStudyTime]);
  const deleteStudyTimeForDate = useCallback((date) => {
    setStudyTime((prev) => {
      const next = { ...prev };
      delete next[date];
      persistStudyTime(next);
      return next;
    });
  }, [persistStudyTime]);
  const persistActiveSession = useCallback((next) => {
    window.storage.set("vocab-active-session", JSON.stringify(next)).catch(() => {});
  }, []);
  const startTimer = useCallback(() => {
    const now = Date.now();
    const session = { startedAt: now, lastSeenAt: now, accumulatedSec: 0 };
    setActiveSession(session);
    persistActiveSession(session);
  }, [persistActiveSession]);
  const stopTimer = useCallback(() => {
    const s = activeSessionRef.current;
    if (!s) return;
    const now = Date.now();
    const finalSec = (s.accumulatedSec || 0) + Math.max(0, Math.floor((now - s.lastSeenAt) / 1000));
    if (finalSec > 0) {
      const dateKey = localDateStr(new Date(s.lastSeenAt));
      const next = { ...studyTimeRef.current, [dateKey]: (studyTimeRef.current[dateKey] || 0) + finalSec };
      setStudyTime(next);
      persistStudyTime(next);
    }
    setActiveSession(null);
    persistActiveSession(null);
    setLiveElapsed(0);
  }, [persistStudyTime, persistActiveSession]);
  const heartbeat = useCallback(() => {
    const s = activeSessionRef.current;
    if (!s) return;
    const now = Date.now();
    const gap = now - s.lastSeenAt;
    if (gap >= IDLE_CAP_MS) {
      // Idle cap exceeded — auto-stop at lastSeenAt, preserve elapsed up to then
      const dateKey = localDateStr(new Date(s.lastSeenAt));
      const accumulated = Math.floor(s.accumulatedSec || 0);
      if (accumulated > 0) {
        const next = { ...studyTimeRef.current, [dateKey]: (studyTimeRef.current[dateKey] || 0) + accumulated };
        setStudyTime(next);
        persistStudyTime(next);
      }
      setActiveSession(null);
      persistActiveSession(null);
      setLiveElapsed(0);
      const gapHours = Math.floor(gap / 3600000);
      const gapMins = Math.floor((gap % 3600000) / 60000);
      const awayLabel = gapHours > 0 ? `${gapHours}h ${gapMins}m` : `${gapMins}m`;
      setTimerToast({ message: `Timer auto-stopped — you were away ${awayLabel}` });
      setTimeout(() => setTimerToast(null), 6000);
      return;
    }
    const updated = { ...s, lastSeenAt: now, accumulatedSec: (s.accumulatedSec || 0) + Math.floor(gap / 1000) };
    setActiveSession(updated);
    persistActiveSession(updated);
  }, [persistStudyTime, persistActiveSession]);
  const saveSettings = useCallback(async (newSettings) => {
    setSettings(newSettings);
    try { await window.storage.set("vocab-settings", JSON.stringify(newSettings)); } catch (e) { console.error("Settings save failed:", e); }
  }, []);
  const addCard = (card) => { setCards((prev) => [...prev, card]); setTimeout(() => save(cardsRef.current, practiceDaysRef.current), 0); setShowAddInline(false); };
  const addCards = (newCards) => { setCards((prev) => [...prev, ...newCards]); setTimeout(() => save(cardsRef.current, practiceDaysRef.current), 0); };
  const deleteCard = useCallback((id) => {
    setCards(prev => {
      const nc = prev.filter((c) => c.id !== id);
      setTimeout(() => save(cardsRef.current, practiceDaysRef.current), 0);
      return nc;
    });
    setDeletedCards(prev => {
      const nd = { ...prev, [id]: Date.now() };
      window.storage.set("vocab-deleted", JSON.stringify(nd)).catch(() => {});
      return nd;
    });
  }, [save]);
  const updateCard = useCallback((id, updated) => {
    setCards(prev => {
      const nc = prev.map((c) => c.id === id ? { ...c, ...updated, modifiedAt: Date.now() } : c);
      setTimeout(() => save(cardsRef.current, practiceDaysRef.current), 0);
      return nc;
    });
  }, [save]);
  const togglePriority = useCallback((id) => {
    setCards(prev => {
      const nc = prev.map((c) => c.id === id ? { ...c, priority: !c.priority, modifiedAt: Date.now() } : c);
      setTimeout(() => save(cardsRef.current, practiceDaysRef.current), 0);
      return nc;
    });
  }, [save]);
  const suspendCard = useCallback((id) => {
    setCards((prev) => {
      const nc = prev.map((c) => c.id === id ? { ...c, suspended: true, modifiedAt: Date.now() } : c);
      setTimeout(() => save(cardsRef.current, practiceDaysRef.current), 0);
      return nc;
    });
  }, [save]);
  const unsuspendCard = useCallback((id) => {
    setCards((prev) => {
      const nc = prev.map((c) => c.id === id ? { ...c, suspended: false, modifiedAt: Date.now() } : c);
      setTimeout(() => save(cardsRef.current, practiceDaysRef.current), 0);
      return nc;
    });
  }, [save]);
  // ─── Backup helpers ───
  const buildBackupBlob = useCallback(() => {
    const safeSettings = { ...settings };
    delete safeSettings.apiKey;
    delete safeSettings.scriptUrl;
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: "1.0.0",
      data: {
        "vocab-cards": cardsRef.current,
        "vocab-practice-days": practiceDaysRef.current,
        "vocab-deleted": deletedCardsRef.current,
        "vocab-settings": safeSettings,
        "vocab-study-time": studyTimeRef.current,
      },
    };
  }, [settings]);
  const exportBackupToFile = useCallback(() => {
    const blob = buildBackupBlob();
    const json = JSON.stringify(blob, null, 2);
    const file = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = `vocabulario_backup_${today()}.json`; a.click();
    URL.revokeObjectURL(url);
    const now = Date.now();
    try { localStorage.setItem("vocab-last-manual-backup", String(now)); } catch {}
    setLastManualBackup(now);
  }, [buildBackupBlob]);
  const applyBackup = useCallback(async (blob) => {
    if (!blob || typeof blob !== "object" || !blob.data) throw new Error("invalid");
    const data = blob.data;
    const keys = ["vocab-cards", "vocab-practice-days", "vocab-deleted", "vocab-settings", "vocab-study-time"];
    for (const k of keys) {
      if (data[k] === undefined) continue;
      try { await window.storage.set(k, JSON.stringify(data[k])); } catch {}
    }
    setBackupToast({ message: t.importBackupSuccess });
    setTimeout(() => window.location.reload(), 800);
  }, []);
  const importBackupFromFile = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const blob = JSON.parse(e.target.result);
        if (!confirm(t.importBackupConfirm)) return;
        await applyBackup(blob);
      } catch (err) {
        setBackupToast({ message: t.importBackupInvalid });
        setTimeout(() => setBackupToast(null), 4000);
      }
    };
    reader.readAsText(file);
  }, [applyBackup]);
  // Auto-snapshot to Sheets — runs at most once per app load and only when > 7 days
  // since the last snapshot. Fire-and-forget; errors are logged but don't block.
  useEffect(() => {
    if (!loaded) return;
    if (!settings.scriptUrl) return;
    const last = Number(lastAutoSnapshot) || 0;
    const sevenDays = 7 * 86400000;
    if (Date.now() - last < sevenDays) return;
    (async () => {
      try {
        const blob = JSON.stringify(buildBackupBlob());
        await GSheets.writeSnapshot(settings.scriptUrl, blob);
        const now = Date.now();
        try { localStorage.setItem("vocab-last-snapshot", String(now)); } catch {}
        setLastAutoSnapshot(now);
      } catch (e) {
        console.warn("Auto-snapshot failed:", e.message);
      }
    })();
    // We only want to attempt once per mount after data has loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, settings.scriptUrl]);
  const loadSnapshotList = useCallback(async () => {
    if (!settings.scriptUrl) {
      setSnapshotListError(t.snapshotPickerError);
      setSnapshotList([]);
      return;
    }
    setSnapshotList(null);
    setSnapshotListError("");
    try {
      const list = await GSheets.listSnapshots(settings.scriptUrl);
      setSnapshotList(list);
    } catch (e) {
      setSnapshotListError(t.snapshotPickerError);
      setSnapshotList([]);
    }
  }, [settings.scriptUrl]);
  const restoreFromSnapshot = useCallback(async (snapshotDate) => {
    if (!settings.scriptUrl) return;
    if (!confirm(t.importBackupConfirm)) return;
    try {
      const raw = await GSheets.readSnapshot(settings.scriptUrl, snapshotDate);
      if (!raw) throw new Error("not found");
      const blob = typeof raw === "string" ? JSON.parse(raw) : raw;
      await applyBackup(blob);
    } catch (e) {
      setBackupToast({ message: t.importBackupInvalid });
      setTimeout(() => setBackupToast(null), 4000);
    }
  }, [settings.scriptUrl, applyBackup]);
  const reviewCard = (id, quality) => {
    const t = today();
    const dev = getDeviceId();
    // Functional updates (compute from the freshest state, never a render-time
    // closure) so a review can't be computed against / clobber a concurrent change
    // — e.g. a sync's setCards landing in the same tick. Persist from refs after
    // commit, matching updateCard/deleteCard/etc.
    setCards((prev) => prev.map((c) => c.id === id ? FSRS.review(c, quality) : c));
    setPracticeDays((prev) => {
      // Migrate legacy numeric entries to the per-device object shape on first write.
      let entry = prev[t];
      if (typeof entry === "number") entry = { __legacy__: entry };
      if (!entry || typeof entry !== "object") entry = {};
      const nd = { ...prev, [t]: { ...entry, [dev]: (entry[dev] || 0) + 1 } };
      setTimeout(() => save(cardsRef.current, practiceDaysRef.current), 0);
      return nd;
    });
  };
  const [skippedIds, setSkippedIds] = useState(new Set());
  const skipCard = (id) => { setSkippedIds((prev) => new Set([...prev, id])); };
  // Tick every 30s so forgot-cards (10min delay) reappear automatically
  const [tick, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 30000); return () => clearInterval(id); }, []);
  // Timer: 30s heartbeat while a session is active
  useEffect(() => {
    if (!activeSession) return;
    const id = setInterval(heartbeat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [activeSession, heartbeat]);
  // Timer: 1s live counter for the ticking UI
  useEffect(() => {
    if (!activeSession) { setLiveElapsed(0); return; }
    const update = () => {
      const s = activeSessionRef.current;
      if (!s) return;
      setLiveElapsed((s.accumulatedSec || 0) + Math.max(0, Math.floor((Date.now() - s.lastSeenAt) / 1000)));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [activeSession]);
  // Timer: persist on visibility change and unload
  useEffect(() => {
    const onHide = () => {
      const s = activeSessionRef.current;
      if (!s) return;
      const now = Date.now();
      const updated = { ...s, lastSeenAt: now, accumulatedSec: (s.accumulatedSec || 0) + Math.max(0, Math.floor((now - s.lastSeenAt) / 1000)) };
      activeSessionRef.current = updated;
      persistActiveSession(updated);
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") onHide();
      else heartbeat();
    };
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [heartbeat, persistActiveSession]);
  const newCardsIntroducedToday = useMemo(() => {
    const t = today();
    // Count only cards genuinely introduced today: firstReviewedAt is today AND
    // the card hasn't graduated past the initial step (reps ≤ 1). This filters
    // out historical cards that got firstReviewedAt set in error by an earlier bug.
    return cards.filter((c) =>
      c.firstReviewedAt === t &&
      c.lastReview === t &&
      (c.reps || 0) <= 1
    ).length;
  }, [cards, tick]);
  const dueCards = useMemo(() => {
    const due = cards.filter((c) => !c.suspended && c.dueDate <= today() && !skippedIds.has(c.id) && (!c.dueAfter || Date.now() >= c.dueAfter));
    // Three buckets:
    //   reviews — already graduated cards
    //   learning — new cards introduced today, still doing 10-min step (reps=0, firstReviewedAt set)
    //   fresh — never-touched new cards
    const reviews = due.filter((c) => (c.reps || 0) > 0);
    const learning = due.filter((c) => (c.reps || 0) === 0 && c.firstReviewedAt);
    const fresh = due.filter((c) => (c.reps || 0) === 0 && !c.firstReviewedAt);
    const sortFn = settings.cardOrder === "newest"
      ? (a, b) => b.id.localeCompare(a.id)
      : (a, b) => a.dueDate.localeCompare(b.dueDate);
    // Priority new cards first; then current sort
    const sortedFresh = [...fresh].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1;
      return sortFn(a, b);
    });
    // Daily new-card cap: only show up to N - already-introduced-today
    const cap = Math.max(0, (settings.newCardsPerDay ?? 10));
    const slots = Math.max(0, cap - newCardsIntroducedToday);
    const freshToday = sortedFresh.slice(0, slots);
    // Learning cards always show (they're past the cap already); show them up-front
    // so the 10-min re-exposure isn't buried at the end of the queue.
    const sortedLearning = [...learning].sort((a, b) => (a.dueAfter || 0) - (b.dueAfter || 0));
    const sortedRest = [...reviews].sort(sortFn);
    const sortedReviews = [...sortedLearning, ...sortedRest];
    // Interleave new cards evenly into the review stream
    if (freshToday.length === 0) return sortedReviews;
    if (sortedReviews.length === 0) return freshToday;
    const result = [];
    const step = sortedReviews.length / freshToday.length;
    let newIdx = 0;
    let nextNewAt = step / 2;
    for (let i = 0; i < sortedReviews.length; i++) {
      while (newIdx < freshToday.length && i >= nextNewAt) {
        result.push(freshToday[newIdx++]);
        nextNewAt += step;
      }
      result.push(sortedReviews[i]);
    }
    while (newIdx < freshToday.length) result.push(freshToday[newIdx++]);
    return result;
  }, [cards, skippedIds, settings.cardOrder, settings.newCardsPerDay, newCardsIntroducedToday, tick]);
  // The card currently being studied is pinned by id, not read off the front of the
  // queue. A background sync can reshuffle dueCards (e.g. an edit synced from another
  // device) — pinning means it can't yank you onto a different card mid-answer. When
  // the pinned card is reviewed/skipped (so it leaves the queue) or otherwise gone,
  // we fall back to the front of the queue and re-pin to it.
  const [currentCardId, setCurrentCardId] = useState(null);
  const currentCard = useMemo(() => {
    if (dueCards.length === 0) return null;
    return dueCards.find((c) => c.id === currentCardId) || dueCards[0];
  }, [dueCards, currentCardId]);
  useEffect(() => {
    if (currentCard && currentCard.id !== currentCardId) setCurrentCardId(currentCard.id);
  }, [currentCard, currentCardId]);
  const sortedCards = useMemo(() => {
    const so = { new: 0, learning: 1, young: 2, mature: 3, mastered: 4 };
    return [...cards].sort((a, b) => {
      let va, vb;
      if (sortKey === "word") { va = (a.word || "").toLowerCase(); vb = (b.word || "").toLowerCase(); }
      else if (sortKey === "translation") { va = (a.translation || "").toLowerCase(); vb = (b.translation || "").toLowerCase(); }
      else if (sortKey === "phrase") { va = (a.phrase || "").toLowerCase(); vb = (b.phrase || "").toLowerCase(); }
      else if (sortKey === "stage") { va = so[getStage(a)]; vb = so[getStage(b)]; }
      else if (sortKey === "dueDate") { va = a.dueDate || ""; vb = b.dueDate || ""; }
      else if (sortKey === "lastReview") { va = a.lastReview || ""; vb = b.lastReview || ""; }
      else if (sortKey === "added") { va = a.id || ""; vb = b.id || ""; }
      else { va = ""; vb = ""; }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      // Secondary sort: when primary keys tie, fall back to newest-added first
      if (sortKey === "stage" || va === vb) {
        const ai = a.id || ""; const bi = b.id || "";
        if (ai < bi) return 1;
        if (ai > bi) return -1;
      }
      return 0;
    });
  }, [cards, sortKey, sortDir]);
  const filteredCards = useMemo(() => {
    if (!searchQuery.trim()) return sortedCards;
    const q = searchQuery.toLowerCase();
    return sortedCards.filter((c) =>
      (c.word || "").toLowerCase().includes(q) || (c.translation || "").toLowerCase().includes(q) || (c.phrase || "").toLowerCase().includes(q)
    );
  }, [sortedCards, searchQuery]);
  // D counts cards you've already studied at least once (graduated reviews + cards
  // introduced today that are in their 10-min learning step). N counts only brand-new,
  // never-touched cards — once a card has firstReviewedAt set, it moves from N → D.
  const dueReview = useMemo(
    () => dueCards.filter(c => (c.reps || 0) > 0 || ((c.reps || 0) === 0 && c.firstReviewedAt)).length,
    [dueCards]
  );
  const dueNew = useMemo(
    () => dueCards.filter(c => (c.reps || 0) === 0 && !c.firstReviewedAt).length,
    [dueCards]
  );
  if (!loaded) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontFamily: font.display, fontSize: 16, fontWeight: 700, color: T.textTertiary }}>carregando...</span>
      </div>
    );
  }
  const practiceBadge = (dueReview || dueNew) ? `${dueReview > 0 ? "D" + dueReview : ""}${dueReview > 0 && dueNew > 0 ? " | " : ""}${dueNew > 0 ? "N" + dueNew : ""}` : null;
  const daysStudiedThisYear = Object.keys(practiceDays).filter((d) => d.startsWith(String(new Date().getFullYear())) && studiedOnDay(practiceDays[d])).length;
  const navItems = [
    { id: "practice", label: t.practice, badge: practiceBadge },
    { id: "words", label: t.words, badge: cards.length || null },
    { id: "heatmap", label: t.progress, badge: `${daysStudiedThisYear} ${settings.lang === "en" ? "days" : "dias"}` },
  ];
  const todayFormatted = new Date().toLocaleDateString(settings.lang === "en" ? "en-US" : "pt-BR", { weekday: "long", day: "numeric", month: "long" });
  // Action buttons (timer, sync, settings) — same JSX rendered in two places:
  // alongside the h1 header on mobile, alongside the tab nav on desktop.
  // Top header buttons — same outline pill / circle pattern as the practice action row
  const headerCircleStyle = {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 36, height: 36, borderRadius: "50%",
    background: T.bgCard,
    border: `1px solid ${T.border}`,
    cursor: "pointer", transition: "all 0.15s",
    flexShrink: 0,
  };
  const headerPillStyle = (color) => ({
    display: "flex", alignItems: "center", gap: 7,
    padding: "0 14px", height: 36, borderRadius: 9999,
    background: T.bgCard,
    border: `1px solid ${T.border}`,
    cursor: "pointer", transition: "all 0.15s",
    fontFamily: font.mono,
    fontSize: mobile ? 11 : 12,
    color: color || T.textSecondary,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: 0.3,
  });
  const headerOnEnter = (e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; };
  const headerOnLeave = (e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.bgCard; };
  const headerActions = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        onClick={() => settings.scriptUrl ? manualSync() : setShowSettingsModal(true)}
        disabled={syncStatus === "syncing"}
        title={syncStatus === "synced" && lastSynced ? `${t.sheetsLastSync} ${lastSynced}` : syncStatus === "error" ? syncError : !settings.scriptUrl ? "Configure Google Sheets sync in settings" : ""}
        style={headerPillStyle(syncStatus === "synced" ? T.success : syncStatus === "error" ? T.danger : T.textSecondary)}
        onMouseEnter={(e) => { if (syncStatus !== "syncing") headerOnEnter(e); }}
        onMouseLeave={headerOnLeave}
      >
        {syncStatus === "syncing" ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={T.textSecondary} strokeWidth="2.5" strokeLinecap="round" style={{ animation: "spin 1s linear infinite" }}>
            <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
            <path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
          </svg>
        ) : syncStatus === "synced" ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={T.success} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        ) : syncStatus === "error" ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={T.danger} strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            <circle cx="12" cy="12" r="10"/>
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={T.textSecondary} strokeWidth="2.5" strokeLinecap="round">
            <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
            <path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
          </svg>
        )}
        <span>
          {syncStatus === "syncing" ? t.sheetsSyncing : syncStatus === "synced" ? (lastSynced || t.sheetsSynced) : syncStatus === "error" ? t.sheetsError : "sync"}
        </span>
      </button>
      <button
        onClick={() => setShowSettingsModal(true)}
        style={headerCircleStyle}
        onMouseEnter={headerOnEnter}
        onMouseLeave={headerOnLeave}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={T.textSecondary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
      </button>
    </div>
  );
  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text }}>
      <style>{`
        html, body { margin: 0; padding: 0; background: ${T.bg}; }
        * { -webkit-font-smoothing: antialiased; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        ::placeholder { color: ${T.textPlaceholder}; }
        textarea::placeholder { color: ${T.textPlaceholder}; }
        button:active { transform: scale(0.98); }
        [contenteditable] b, [contenteditable] strong { color: ${T.keyword}; font-weight: 700; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        input[type="number"]::-webkit-inner-spin-button,
        input[type="number"]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type="number"] { -moz-appearance: textfield; }
        .nav-scroll::-webkit-scrollbar { display: none; }
        .nav-scroll { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
      <div style={{ padding: mobile ? "16px 16px 0" : "18px 36px 0", maxWidth: 1200, margin: "0 auto" }}>
        {mobile && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
            {headerActions}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, paddingBottom: mobile ? 0 : 14, borderBottom: `1px solid ${T.border}` }}>
        <div className="nav-scroll" style={{ display: mobile ? "none" : "flex", gap: 28, overflowX: "auto", WebkitOverflowScrolling: "touch", flex: 1, minWidth: 0 }}>
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              style={{
                padding: mobile ? "10px 14px" : "8px 0",
                background: "none",
                border: "none",
                borderBottom: view === item.id ? `4px solid ${T.text}` : "4px solid transparent",
                marginBottom: 0,
                color: view === item.id ? T.text : T.textTertiary,
                fontFamily: font.body,
                fontSize: mobile ? 11 : 12,
                fontWeight: 500,
                cursor: "pointer",
                transition: "color 0.15s, border-color 0.15s",
                display: "flex",
                alignItems: "baseline",
                gap: 10,
                letterSpacing: 2.5,
                textTransform: "uppercase",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { if (view !== item.id) e.currentTarget.style.color = T.textSecondary; }}
              onMouseLeave={(e) => { if (view !== item.id) e.currentTarget.style.color = T.textTertiary; }}
            >
              {item.label}
              {item.badge && (
                <span style={{
                  fontFamily: font.mono,
                  fontSize: 10,
                  fontWeight: 500,
                  color: view === item.id ? T.textSecondary : T.textPlaceholder,
                  letterSpacing: 0.5,
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </div>
        {!mobile && (
          <div>
            {headerActions}
          </div>
        )}
        </div>
      </div>
      <div style={{ padding: mobile ? "20px 16px 100px" : "32px 36px 60px", maxWidth: 1200, margin: "0 auto" }}>
        {view === "practice" && (
          <>
            {!currentCard ? (
              <div style={{ textAlign: "center", padding: "80px 20px" }}>
                <div style={{ width: 48, height: 48, borderRadius: 24, background: T.accentSoft, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={T.textSecondary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div style={{ fontFamily: font.display, fontSize: 24, fontWeight: 700, color: T.text, marginBottom: 8, textTransform: "capitalize" }}>
                  {cards.length === 0 ? t.startHere : t.allCaughtUp}
                </div>
                <div style={{ fontFamily: font.body, fontSize: 14, color: T.textTertiary, marginBottom: 32, lineHeight: 1.6 }}>
                  {cards.length === 0
                    ? t.addWordsToStart
                    : (() => {
                        const next = cards.filter((c) => c.dueDate > today()).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
                        return next ? `${t.nextReview}: ${new Date(next.dueDate + "T12:00:00").toLocaleDateString("pt-BR", { day: "numeric", month: "short" })}` : "";
                      })()
                  }
                </div>
                {cards.length === 0 && (
                  <button onClick={() => { setView("words"); setShowImportInline(true); }} style={{
                    padding: "13px 32px", background: T.accent, border: "none", borderRadius: T.radiusSm,
                    color: T.bg, fontFamily: font.body, fontSize: 14, fontWeight: 600, cursor: "pointer", letterSpacing: 0.3, transition: "all 0.15s",
                  }}
                    onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.85"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
                  >
                    adicionar primeira palavra
                  </button>
                )}
              </div>
            ) : (
              <PracticeCard key={currentCard.id} card={currentCard} onReview={reviewCard} onSkip={skipCard} onUpdate={updateCard} onSuspend={suspendCard} totalDue={dueCards.length} studyDirection={studyDirection} answerMode={answerMode} setAnswerMode={setAnswerMode} activeSession={activeSession} liveElapsed={liveElapsed} onStartTimer={startTimer} onStopTimer={stopTimer} />
            )}
          </>
        )}
        {view === "words" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <div style={{ position: "relative", width: mobile ? undefined : "30%", flex: mobile ? 1 : undefined }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={T.textPlaceholder} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder=""
                  style={{
                    width: "100%", boxSizing: "border-box",
                    padding: "9px 12px 9px 36px",
                    background: T.bgInput, border: `1px solid ${T.border}`,
                    borderRadius: T.radiusSm, color: T.text,
                    fontFamily: font.body, fontSize: 13, outline: "none",
                    transition: "border-color 0.15s",
                  }}
                  onFocus={(e) => { e.target.style.borderColor = T.borderStrong; }}
                  onBlur={(e) => { e.target.style.borderColor = T.border; }}
                />
              </div>
              <div style={{ position: "relative", marginLeft: mobile ? 0 : "auto" }}>
                <button
                  onClick={() => setSortMenuOpen((o) => !o)}
                  style={{
                    padding: mobile ? "0 16px" : "0 18px",
                    height: 40,
                    background: T.bgCard,
                    border: `1px solid ${sortMenuOpen ? T.text : T.border}`,
                    borderRadius: 9999,
                    color: sortMenuOpen ? T.text : T.textSecondary,
                    fontFamily: font.body, fontSize: 13, fontWeight: 500, cursor: "pointer", letterSpacing: 0.2,
                    display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => { if (!sortMenuOpen) { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; } }}
                  onMouseLeave={(e) => { if (!sortMenuOpen) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.bgCard; } }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="4" y1="6" x2="20" y2="6" /><line x1="6" y1="12" x2="18" y2="12" /><line x1="9" y1="18" x2="15" y2="18" />
                  </svg>
                  {!mobile && t.sortBy}
                </button>
                {sortMenuOpen && (
                  <>
                    <div onClick={() => setSortMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
                    <div style={{
                      position: "absolute", right: 0, top: "100%", marginTop: 6, zIndex: 31,
                      background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                      boxShadow: T.shadowLg, overflow: "hidden", minWidth: 230, padding: 4,
                    }}>
                      {[
                        { key: "added", label: t.sortAdded },
                        { key: "dueDate", label: t.headerDue },
                        { key: "lastReview", label: t.headerLastStudied },
                        { key: "stage", label: t.headerStage },
                      ].map((f) => {
                        const isActive = sortKey === f.key;
                        return (
                          <div key={f.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "7px 8px 7px 12px", borderRadius: 8 }}>
                            <span style={{ fontFamily: font.body, fontSize: 13, color: isActive ? T.text : T.textSecondary, fontWeight: isActive ? 600 : 400 }}>
                              {f.label}
                            </span>
                            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                              {["asc", "desc"].map((dir) => {
                                const on = isActive && sortDir === dir;
                                return (
                                  <button
                                    key={dir}
                                    onClick={() => { setSortKey(f.key); setSortDir(dir); setGroupByStage(false); setCollapsedGroups(new Set()); setSortMenuOpen(false); }}
                                    title={dir === "asc" ? t.sortAsc : t.sortDesc}
                                    aria-label={`${f.label} — ${dir === "asc" ? t.sortAsc : t.sortDesc}`}
                                    style={{
                                      width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
                                      background: on ? T.text : "transparent",
                                      border: `1px solid ${on ? T.text : T.border}`,
                                      borderRadius: 6, cursor: "pointer", transition: "all 0.12s", padding: 0,
                                    }}
                                  >
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={on ? T.bg : T.textSecondary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: dir === "desc" ? "rotate(180deg)" : "none" }}>
                                      <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                                    </svg>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={() => {
                  const next = !groupByStage;
                  setGroupByStage(next);
                  // Turning grouping on collapses every accordion by default.
                  setCollapsedGroups(next ? new Set(["new", "learning", "young", "mature", "mastered", "suspended"]) : new Set());
                }}
                style={{
                  padding: mobile ? "0 16px" : "0 18px",
                  height: 40,
                  background: T.bgCard,
                  border: `1px solid ${groupByStage ? T.text : T.border}`,
                  borderRadius: 9999,
                  color: groupByStage ? T.text : T.textSecondary,
                  fontFamily: font.body, fontSize: 13, fontWeight: 500, cursor: "pointer", letterSpacing: 0.2,
                  display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { if (!groupByStage) { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; } }}
                onMouseLeave={(e) => { if (!groupByStage) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.bgCard; } }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                </svg>
                {!mobile && t.groupByStage}
              </button>
              <button
                onClick={() => setShowImportInline(true)}
                style={{
                  padding: "0 20px", height: 40, background: T.accent,
                  border: "none",
                  borderRadius: 9999,
                  color: T.bg,
                  fontFamily: font.body, fontSize: 13, fontWeight: 500, cursor: "pointer", letterSpacing: 0.2,
                  display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.85"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                {t.import}
              </button>
            </div>
            <Modal open={showImportInline} onClose={() => setShowImportInline(false)} title={t.importWords}>
              <ImportPanel onImport={(newCards) => { addCards(newCards); setShowImportInline(false); }} existingCount={cards.length} />
            </Modal>
            {cards.length === 0 ? (
              <div style={{ textAlign: "center", padding: "60px 20px", color: T.textTertiary, fontFamily: font.body, fontSize: 14 }}>
                nenhuma palavra adicionada ainda
              </div>
            ) : (
              <div style={{ borderRadius: T.radius, border: `1px solid ${T.border}`, background: T.bgCard }}>
                <div style={{ display: mobile ? "none" : "grid", gridTemplateColumns: "1fr 1fr 90px 90px 90px 32px", gap: 12, padding: "11px 20px", borderBottom: `1px solid ${T.border}` }}>
                  {[
                    { key: null, label: t.headerEnglish, indent: true },
                    { key: null, label: t.headerPortuguese, indent: true },
                    { key: "stage", label: t.headerStage },
                    { key: "dueDate", label: t.headerDue },
                    { key: "lastReview", label: t.headerLastStudied },
                    { key: null, label: "" },
                  ].map((col, ci) => (
                    <span
                      key={ci}
                      onClick={() => {
                        if (!col.key) return;
                        if (sortKey === col.key) {
                          setSortDir((prev) => prev === "asc" ? "desc" : "asc");
                        } else {
                          setSortKey(col.key);
                          setSortDir("asc");
                        }
                      }}
                      style={{
                        fontFamily: font.mono, fontSize: 9,
                        color: sortKey === col.key ? T.text : T.textTertiary,
                        fontWeight: sortKey === col.key ? 700 : 500,
                        textTransform: "uppercase", letterSpacing: 2,
                        cursor: col.key ? "pointer" : "default",
                        userSelect: "none",
                        paddingLeft: col.indent ? 9 : 0,
                        display: "flex", alignItems: "center", gap: 6,
                        transition: "color 0.15s",
                      }}
                      onMouseEnter={(e) => { if (col.key) e.currentTarget.style.color = T.text; }}
                      onMouseLeave={(e) => { if (col.key) e.currentTarget.style.color = sortKey === col.key ? T.text : T.textTertiary; }}
                    >
                      {col.label}
                      {col.key && (() => {
                        const isActive = sortKey === col.key;
                        const ascActive = isActive && sortDir === "asc";
                        const descActive = isActive && sortDir === "desc";
                        const idle = T.textPlaceholder;
                        const on = T.text;
                        return (
                          <svg width="9" height="12" viewBox="0 0 10 14" fill="none" aria-hidden style={{ flexShrink: 0 }}>
                            <polyline points="2,5 5,2 8,5" stroke={ascActive ? on : idle} strokeWidth={ascActive ? 2.5 : 1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                            <polyline points="2,9 5,12 8,9" stroke={descActive ? on : idle} strokeWidth={descActive ? 2.5 : 1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
                          </svg>
                        );
                      })()}
                    </span>
                  ))}
                </div>
                {(() => {
                  const activeCards = filteredCards.filter(c => !c.suspended);
                  const suspendedCards = filteredCards.filter(c => c.suspended);
                  const isDark = T.bg === "#0E0E0E";
                  const suspendedCollapsed = collapsedGroups.has("suspended");
                  return (
                    <>
                      {groupByStage ? (
                        ["new", "learning", "young", "mature", "mastered"].map(stage => {
                          // Sub-sort by newest-added within each stage group.
                          const stageCards = activeCards.filter(c => getStage(c) === stage).sort((a, b) => (b.id || "").localeCompare(a.id || ""));
                          if (stageCards.length === 0) return null;
                          const sc = stageColors[stage];
                          const isCollapsed = collapsedGroups.has(stage);
                          return (
                            <div key={stage}>
                              <div
                                onClick={() => toggleGroup(stage)}
                                style={{
                                  display: "flex", alignItems: "center", gap: 10,
                                  padding: "10px 20px",
                                  background: sc.bg,
                                  borderBottom: `1px solid ${T.border}`,
                                  cursor: "pointer", userSelect: "none",
                                  position: "sticky", top: 0, zIndex: 2,
                                  transition: "filter 0.15s",
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(0.97)"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isDark ? sc.darkText : sc.text} strokeWidth="2.5" strokeLinecap="round"
                                  style={{ transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
                                >
                                  <polyline points="6 9 12 15 18 9"/>
                                </svg>
                                <span style={{
                                  fontFamily: font.mono, fontSize: 11, padding: "3px 10px", borderRadius: 20, letterSpacing: 0.5,
                                  background: sc.bg, color: isDark ? sc.darkText : sc.text, fontWeight: 600,
                                }}>
                                  {stageLabel(stage)}
                                </span>
                                <span style={{ fontFamily: font.mono, fontSize: 11, color: T.textTertiary }}>
                                  {stageCards.length}
                                </span>
                              </div>
                              {!isCollapsed && stageCards.map(card => (
                                <WordRow key={card.id} card={card} onDelete={deleteCard} onSpeak={speakPT} onUpdate={updateCard} onTogglePriority={togglePriority} onSuspend={suspendCard} onUnsuspend={unsuspendCard} />
                              ))}
                            </div>
                          );
                        })
                      ) : (
                        activeCards.map((card) => <WordRow key={card.id} card={card} onDelete={deleteCard} onSpeak={speakPT} onUpdate={updateCard} onTogglePriority={togglePriority} onSuspend={suspendCard} onUnsuspend={unsuspendCard} />)
                      )}
                      {suspendedCards.length > 0 && (
                        <div style={{ opacity: 0.6 }}>
                          <div
                            onClick={() => toggleGroup("suspended")}
                            style={{
                              display: "flex", alignItems: "center", gap: 10,
                              padding: "10px 20px",
                              background: T.bgCardHover,
                              borderTop: `1px solid ${T.border}`,
                              borderBottom: `1px solid ${T.border}`,
                              cursor: "pointer", userSelect: "none",
                              position: "sticky", top: 0, zIndex: 2,
                              transition: "filter 0.15s",
                            }}
                            onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(0.97)"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={T.textSecondary} strokeWidth="2.5" strokeLinecap="round"
                              style={{ transform: suspendedCollapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}
                            >
                              <polyline points="6 9 12 15 18 9"/>
                            </svg>
                            <SuspendIcon size={14} color={T.textSecondary} />
                            <span style={{
                              fontFamily: font.mono, fontSize: 11, padding: "3px 10px", borderRadius: 20, letterSpacing: 0.5,
                              background: T.bgInput, color: T.textSecondary, fontWeight: 600, textTransform: "uppercase",
                            }}>
                              {t.suspended}
                            </span>
                            <span style={{ fontFamily: font.mono, fontSize: 11, color: T.textTertiary }}>
                              {suspendedCards.length}
                            </span>
                          </div>
                          {!suspendedCollapsed && suspendedCards.map(card => (
                            <WordRow key={card.id} card={card} onDelete={deleteCard} onSpeak={speakPT} onUpdate={updateCard} onTogglePriority={togglePriority} onSuspend={suspendCard} onUnsuspend={unsuspendCard} />
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
          </>
        )}
        {view === "heatmap" && (
          <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: T.textTertiary }}>...</div>}>
          <RechartsModule>
          {({ PieChart, Pie, Label, Tooltip: RechartsTooltip, Cell, AreaChart, Area, XAxis, YAxis, CartesianGrid, ResponsiveContainer, BarChart, Bar }) => (
          <>
            <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: mobile ? 8 : 14, marginBottom: 14 }}>
              {[
                { label: t.daysStudied, value: (() => {
                  const yr = new Date().getFullYear();
                  return Object.keys(practiceDays).filter((d) => d.startsWith(String(yr)) && studiedOnDay(practiceDays[d])).length;
                })() },
                { label: t.dayStreak, value: (() => {
                  let streak = 0;
                  let d = new Date();
                  if (!studiedOnDay(practiceDays[localDateStr(d)])) {
                    d.setDate(d.getDate() - 1);
                  }
                  while (true) {
                    const ds = localDateStr(d);
                    if (studiedOnDay(practiceDays[ds])) { streak++; d.setDate(d.getDate() - 1); } else break;
                  }
                  return streak;
                })() },
                { label: t.avgPerDay, value: (() => {
                  const totals = Object.values(practiceDays).map(totalForDay).filter((v) => v > 0);
                  if (!totals.length) return 0;
                  return (totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(1);
                })() },
                { label: t.totalTime, editable: true, value: (() => {
                  const yr = String(new Date().getFullYear());
                  const totalSec = Object.entries(studyTime)
                    .filter(([d]) => d.startsWith(yr))
                    .reduce((a, [, s]) => a + (s || 0), 0)
                    + (activeSession ? liveElapsed : 0);
                  return formatDuration(totalSec, { short: true });
                })() },
              ].map((stat, i) => (
                <div key={i} style={{ position: "relative", background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: mobile ? "14px 8px" : "22px 16px", textAlign: "center" }}>
                  {stat.editable && (
                    <button
                      onClick={() => setShowStudyTimeEditModal(true)}
                      aria-label={t.editTimeLogs}
                      title={t.editTimeLogs}
                      style={{
                        position: "absolute", top: 8, right: 8,
                        background: "transparent", border: "none", cursor: "pointer",
                        padding: 6, borderRadius: 6, opacity: 0.4, transition: "opacity 0.15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.4"; }}
                    >
                      <PencilIcon size={14} color={T.textSecondary} />
                    </button>
                  )}
                  <div style={{ fontFamily: font.display, fontSize: mobile ? 22 : 32, fontWeight: 700, color: T.text }}>{stat.value}</div>
                  <div style={{ fontFamily: font.mono, fontSize: mobile ? 8 : 9, color: T.textTertiary, textTransform: "uppercase", letterSpacing: mobile ? 1 : 1.8, marginTop: 4 }}>{stat.label}</div>
                </div>
              ))}
            </div>
            {(() => {
              const ranges = { day: 30, week: 12, month: 12, year: 5 };
              const range = ranges[studyTimePeriod] || 12;
              const data = aggregateStudyTime(studyTime, studyTimePeriod, range).map((b) => ({
                ...b,
                minutes: Math.round(b.seconds / 60),
                hours: +(b.seconds / 3600).toFixed(2),
                value: (studyTimePeriod === "month" || studyTimePeriod === "year") ? +(b.seconds / 3600).toFixed(2) : Math.round(b.seconds / 60),
              }));
              const yUnit = (studyTimePeriod === "month" || studyTimePeriod === "year") ? "h" : "m";
              const hasAny = data.some((d) => d.seconds > 0);
              return (
                <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: mobile ? "16px 16px 8px" : "22px 24px 14px", marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
                    <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text }}>
                      {t.studyTimeReport}
                    </div>
                    <div style={{ display: "inline-flex", background: T.bgInput, borderRadius: T.radiusSm, padding: 3 }}>
                      {[
                        { id: "week", label: t.periodWeek },
                        { id: "month", label: t.periodMonth },
                        { id: "year", label: t.periodYear },
                      ].map((opt) => (
                        <button
                          key={opt.id}
                          onClick={() => setStudyTimePeriod(opt.id)}
                          style={{
                            padding: "5px 14px",
                            background: studyTimePeriod === opt.id ? T.bgCard : "transparent",
                            border: "none", borderRadius: 10,
                            fontFamily: font.mono, fontSize: 11, fontWeight: 500,
                            color: studyTimePeriod === opt.id ? T.text : T.textTertiary,
                            cursor: "pointer", transition: "all 0.15s",
                            boxShadow: studyTimePeriod === opt.id ? T.shadow : "none",
                            letterSpacing: 0.5,
                          }}
                          onMouseEnter={(e) => { if (studyTimePeriod !== opt.id) e.currentTarget.style.background = T.bgCardHover; }}
                          onMouseLeave={(e) => { if (studyTimePeriod !== opt.id) e.currentTarget.style.background = "transparent"; }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {hasAny ? (
                    <ResponsiveContainer width="100%" height={mobile ? 180 : 220}>
                      <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                        <CartesianGrid stroke={T.border} strokeDasharray="2 4" vertical={false} />
                        <XAxis dataKey="label" tick={{ fill: T.textTertiary, fontFamily: font.mono, fontSize: 10 }} axisLine={{ stroke: T.border }} tickLine={false} interval={mobile && studyTimePeriod === "day" ? 4 : 0} />
                        <YAxis tick={{ fill: T.textTertiary, fontFamily: font.mono, fontSize: 10 }} axisLine={false} tickLine={false} width={36} tickFormatter={(v) => `${v}${yUnit}`} />
                        <RechartsTooltip
                          cursor={{ fill: T.bgCardHover }}
                          content={({ active, payload }) => {
                            if (active && payload && payload.length) {
                              const d = payload[0].payload;
                              return (
                                <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 12px", boxShadow: T.shadowLg }}>
                                  <div style={{ fontFamily: font.mono, fontSize: 10, color: T.textTertiary, marginBottom: 4 }}>{d.startDate}</div>
                                  <div style={{ fontFamily: font.body, fontSize: 13, fontWeight: 600, color: T.text }}>{formatDuration(d.seconds, { short: true })}</div>
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                        <Bar dataKey="value" fill={T.accent} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div style={{ padding: "40px 20px", textAlign: "center", fontFamily: font.body, fontSize: 13, color: T.textTertiary }}>
                      No study time logged yet — start the timer on the Study page.
                    </div>
                  )}
                </div>
              );
            })()}
            <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: mobile ? 12 : 28, overflowX: "auto", marginBottom: 14 }}>
              <CalendarHeatmap practiceDays={practiceDays} year={heatmapYear} onYearChange={setHeatmapYear} />
            </div>
            {cards.length > 0 && (() => {
              const stages = ["new", "learning", "young", "mature", "mastered"];
              const isDark = T.bg === "#0E0E0E";
              const counts = {};
              stages.forEach((s) => { counts[s] = 0; });
              cards.forEach((c) => { counts[getStage(c)]++; });
              const total = cards.length;
              const chartData = stages
                .filter((s) => counts[s] > 0)
                .map((s) => ({
                  name: stageLabel(s),
                  value: counts[s],
                  fill: isDark ? stageColors[s].darkText : stageColors[s].text,
                  stage: s,
                }));
              const reviewedCards = cards.filter(c => c.reps > 0);
              const nowDate = new Date();
              const recallBands = [
                { key: "strong", label: t.recallStrong, color: T.success, count: 0 },
                { key: "good", label: t.recallGood, color: T.accent, count: 0 },
                { key: "fading", label: t.recallFading, color: T.warning, count: 0 },
                { key: "atRisk", label: t.recallAtRisk, color: T.danger, count: 0 },
              ];
              reviewedCards.forEach(c => {
                const elapsed = c.lastReview ? Math.max(0, (nowDate - new Date(c.lastReview + "T12:00:00")) / 86400000) : 0;
                const r = FSRS.retrievability(elapsed, c.stability);
                if (r >= 0.9) recallBands[0].count++;
                else if (r >= 0.7) recallBands[1].count++;
                else if (r >= 0.5) recallBands[2].count++;
                else recallBands[3].count++;
              });
              const avgRecall = reviewedCards.length > 0
                ? Math.round(reviewedCards.reduce((sum, c) => {
                    const elapsed = c.lastReview ? Math.max(0, (nowDate - new Date(c.lastReview + "T12:00:00")) / 86400000) : 0;
                    return sum + FSRS.retrievability(elapsed, c.stability);
                  }, 0) / reviewedCards.length * 100)
                : 0;
              const recallChartData = recallBands.filter(b => b.count > 0).map(b => ({ name: b.label, value: b.count, fill: b.color }));
              return (
                <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 14, marginBottom: 14 }}>
                <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: mobile ? "16px 16px 24px" : 28 }}>
                  <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                    {t.stageBreakdown}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 24 }}>
                    {total} {total === 1 ? t.word : t.wordsPlural}
                  </div>
                  <div style={{ display: "flex", flexDirection: mobile ? "column" : "row", alignItems: "center", justifyContent: "center", gap: mobile ? 24 : 80 }}>
                    <div style={{ flexShrink: 0 }}>
                      <PieChart width={mobile ? 160 : 190} height={mobile ? 160 : 190}>
                        <Pie
                          data={chartData}
                          cx={mobile ? 80 : 95}
                          cy={mobile ? 80 : 95}
                          innerRadius={mobile ? 50 : 62}
                          outerRadius={mobile ? 74 : 88}
                          paddingAngle={1}
                          dataKey="value"
                          nameKey="name"
                          strokeWidth={0}
                        >
                          {chartData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={entry.fill} />
                          ))}
                          <Label
                            content={({ viewBox }) => {
                              if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                                return (
                                  <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                                    <tspan x={viewBox.cx} y={viewBox.cy - 5} style={{ fontSize: 24, fontWeight: 700, fill: T.text, fontFamily: font.display }}>
                                      {total}
                                    </tspan>
                                    <tspan x={viewBox.cx} y={viewBox.cy + 14} style={{ fontSize: 8, fill: T.textTertiary, fontFamily: font.mono, textTransform: "uppercase", letterSpacing: "1.5px" }}>
                                      {t.wordsPlural}
                                    </tspan>
                                  </text>
                                );
                              }
                            }}
                          />
                        </Pie>
                        <RechartsTooltip
                          content={({ active, payload }) => {
                            if (active && payload && payload.length) {
                              const d = payload[0];
                              const pct = Math.round((d.value / total) * 100);
                              return (
                                <div style={{
                                  background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8,
                                  padding: "8px 12px", boxShadow: T.shadowLg,
                                }}>
                                  <div style={{ fontFamily: font.body, fontSize: 13, fontWeight: 500, color: T.text }}>{d.name}</div>
                                  <div style={{ fontFamily: font.mono, fontSize: 12, color: T.textTertiary, marginTop: 2 }}>
                                    {d.value} ({pct}%)
                                  </div>
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                      </PieChart>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {stages.map((stage) => {
                        const count = counts[stage];
                        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                        const color = isDark ? stageColors[stage].darkText : stageColors[stage].text;
                        return (
                          <div key={stage} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
                            <span style={{ fontFamily: font.body, fontSize: 13, fontWeight: 500, color: T.text, minWidth: 80 }}>
                              {stageLabel(stage)}
                            </span>
                            <span style={{ fontFamily: font.mono, fontSize: 12, color: T.textTertiary, minWidth: 24, textAlign: "right" }}>
                              {count}
                            </span>
                            <span style={{ fontFamily: font.mono, fontSize: 11, color: T.textTertiary, minWidth: 32, textAlign: "right" }}>
                              {pct}%
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: mobile ? "16px 16px 24px" : 28 }}>
                  <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                    {t.recallRate}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 24 }}>
                    {reviewedCards.length} {reviewedCards.length === 1 ? t.word : t.wordsPlural}
                  </div>
                  {reviewedCards.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: mobile ? "column" : "row", alignItems: "center", justifyContent: "center", gap: mobile ? 24 : 80 }}>
                      <div style={{ flexShrink: 0 }}>
                        <PieChart width={mobile ? 160 : 190} height={mobile ? 160 : 190}>
                          <Pie
                            data={recallChartData}
                            cx={mobile ? 80 : 95}
                            cy={mobile ? 80 : 95}
                            innerRadius={mobile ? 50 : 62}
                            outerRadius={mobile ? 74 : 88}
                            paddingAngle={1}
                            dataKey="value"
                            nameKey="name"
                            strokeWidth={0}
                          >
                            {recallChartData.map((entry, index) => (
                              <Cell key={`recall-${index}`} fill={entry.fill} />
                            ))}
                            <Label
                              content={({ viewBox }) => {
                                if (viewBox && "cx" in viewBox && "cy" in viewBox) {
                                  return (
                                    <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
                                      <tspan x={viewBox.cx} y={viewBox.cy - 5} style={{ fontSize: 24, fontWeight: 700, fill: T.text, fontFamily: font.display }}>
                                        {avgRecall}%
                                      </tspan>
                                      <tspan x={viewBox.cx} y={viewBox.cy + 14} style={{ fontSize: 8, fill: T.textTertiary, fontFamily: font.mono, textTransform: "uppercase", letterSpacing: "1.5px" }}>
                                        {t.recallLabel}
                                      </tspan>
                                    </text>
                                  );
                                }
                              }}
                            />
                          </Pie>
                          <RechartsTooltip
                            content={({ active, payload }) => {
                              if (active && payload && payload.length) {
                                const d = payload[0];
                                const pct = Math.round((d.value / reviewedCards.length) * 100);
                                return (
                                  <div style={{
                                    background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8,
                                    padding: "8px 12px", boxShadow: T.shadowLg,
                                  }}>
                                    <div style={{ fontFamily: font.body, fontSize: 13, fontWeight: 500, color: T.text }}>{d.name}</div>
                                    <div style={{ fontFamily: font.mono, fontSize: 12, color: T.textTertiary, marginTop: 2 }}>
                                      {d.value} ({pct}%)
                                    </div>
                                  </div>
                                );
                              }
                              return null;
                            }}
                          />
                        </PieChart>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        {recallBands.map((band) => {
                          const pct = reviewedCards.length > 0 ? Math.round((band.count / reviewedCards.length) * 100) : 0;
                          return (
                            <div key={band.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 8, height: 8, borderRadius: 2, background: band.color, flexShrink: 0 }} />
                              <span style={{ fontFamily: font.body, fontSize: 13, fontWeight: 500, color: T.text, minWidth: 80 }}>
                                {band.label}
                              </span>
                              <span style={{ fontFamily: font.mono, fontSize: 12, color: T.textTertiary, minWidth: 24, textAlign: "right" }}>
                                {band.count}
                              </span>
                              <span style={{ fontFamily: font.mono, fontSize: 11, color: T.textTertiary, minWidth: 32, textAlign: "right" }}>
                                {pct}%
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div style={{ textAlign: "center", padding: "40px 20px", color: T.textTertiary, fontFamily: font.body, fontSize: 13 }}>
                      {t.addWordsToStart}
                    </div>
                  )}
                </div>
                </div>
              );
            })()}
            {(() => {
              const isDark = T.bg === "#0E0E0E";
              const accentColor = isDark ? "#6FCF97" : "#2D6A4F";
              const now = new Date();
              let daysBack = 30;
              if (activityRange === "week") daysBack = 7;
              else if (activityRange === "year") daysBack = 365;
              const chartData = [];
              for (let i = daysBack - 1; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                const ds = localDateStr(d);
                chartData.push({
                  date: ds,
                  reviews: totalForDay(practiceDays[ds]),
                });
              }
              const totalInRange = chartData.reduce((a, b) => a + b.reviews, 0);
              return (
                <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, overflow: "hidden", boxShadow: T.shadow, marginTop: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 28px", borderBottom: `1px solid ${T.border}` }}>
                    <div>
                      <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text }}>
                        {t.studyActivity}
                      </div>
                      <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginTop: 2 }}>
                        {t.studyActivityDesc}
                      </div>
                    </div>
                    <div style={{ display: "inline-flex", background: T.bgInput, borderRadius: T.radiusSm, padding: 3 }}>
                      {[
                        { id: "week", label: t.periodWeek },
                        { id: "month", label: t.periodMonth },
                        { id: "year", label: t.periodYear },
                      ].map((opt) => (
                        <button
                          key={opt.id}
                          onClick={() => setActivityRange(opt.id)}
                          style={{
                            padding: "5px 14px",
                            background: activityRange === opt.id ? T.bgCard : "transparent",
                            border: "none", borderRadius: 10,
                            fontFamily: font.mono, fontSize: 11, fontWeight: 500,
                            color: activityRange === opt.id ? T.text : T.textTertiary,
                            cursor: "pointer", transition: "all 0.15s",
                            boxShadow: activityRange === opt.id ? T.shadow : "none",
                            letterSpacing: 0.5,
                          }}
                          onMouseEnter={(e) => { if (activityRange !== opt.id) e.currentTarget.style.background = T.bgCardHover; }}
                          onMouseLeave={(e) => { if (activityRange !== opt.id) e.currentTarget.style.background = "transparent"; }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ padding: "20px 20px 16px" }}>
                    <ResponsiveContainer width="100%" height={220}>
                      <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 0 }}>
                        <defs>
                          <linearGradient id="fillReviews" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={accentColor} stopOpacity={0.3} />
                            <stop offset="95%" stopColor={accentColor} stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid vertical={false} stroke={T.border} strokeDasharray="3 3" />
                        <XAxis
                          dataKey="date"
                          tickLine={false}
                          axisLine={false}
                          tickMargin={10}
                          minTickGap={activityRange === "year" ? 60 : activityRange === "month" ? 40 : 20}
                          tick={{ fontSize: 11, fill: T.textTertiary, fontFamily: font.mono }}
                          tickFormatter={(value) => {
                            const d = new Date(value + "T12:00:00");
                            if (activityRange === "year") return d.toLocaleDateString(settings.lang === "en" ? "en-US" : "pt-BR", { month: "short" });
                            return d.toLocaleDateString(settings.lang === "en" ? "en-US" : "pt-BR", { month: "short", day: "numeric" });
                          }}
                        />
                        <RechartsTooltip
                          cursor={{ stroke: T.border, strokeWidth: 1 }}
                          content={({ active, payload, label }) => {
                            if (active && payload && payload.length) {
                              const d = new Date(label + "T12:00:00");
                              return (
                                <div style={{
                                  background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8,
                                  padding: "8px 12px", boxShadow: T.shadowLg,
                                }}>
                                  <div style={{ fontFamily: font.body, fontSize: 12, color: T.textTertiary, marginBottom: 4 }}>
                                    {d.toLocaleDateString(settings.lang === "en" ? "en-US" : "pt-BR", { month: "short", day: "numeric", year: "numeric" })}
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <div style={{ width: 8, height: 8, borderRadius: 4, background: accentColor }} />
                                    <span style={{ fontFamily: font.body, fontSize: 13, fontWeight: 500, color: T.text }}>
                                      {payload[0].value} {t.wordsReviewed.toLowerCase()}
                                    </span>
                                  </div>
                                </div>
                              );
                            }
                            return null;
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="reviews"
                          stroke={accentColor}
                          strokeWidth={2}
                          fill="url(#fillReviews)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ padding: "0 28px 20px", display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 4, background: accentColor }} />
                    <span style={{ fontFamily: font.body, fontSize: 12, color: T.textTertiary }}>
                      {totalInRange} {t.wordsReviewed.toLowerCase()} · {activityRange === "week" ? t.thisWeek.toLowerCase() : activityRange === "month" ? t.thisMonth.toLowerCase() : t.thisYear.toLowerCase()}
                    </span>
                  </div>
                </div>
              );
            })()}
          </>
          )}
          </RechartsModule>
          </Suspense>
        )}
        {timerToast && (
          <div style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
            padding: "12px 20px", boxShadow: T.shadowLg,
            fontFamily: font.body, fontSize: 13, color: T.text,
            zIndex: 200, maxWidth: "90vw",
          }}>
            {timerToast.message}
          </div>
        )}
        {backupToast && (
          <div style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
            padding: "12px 20px", boxShadow: T.shadowLg,
            fontFamily: font.body, fontSize: 13, color: T.text,
            zIndex: 200, maxWidth: "90vw",
          }}>
            {backupToast.message}
          </div>
        )}
        <Modal open={showSnapshotPicker} onClose={() => setShowSnapshotPicker(false)} title={t.snapshotPickerTitle}>
          {snapshotList === null ? (
            <div style={{ padding: "40px 20px", textAlign: "center", fontFamily: font.body, fontSize: 13, color: T.textTertiary }}>…</div>
          ) : snapshotListError ? (
            <div style={{ padding: "40px 20px", textAlign: "center", fontFamily: font.body, fontSize: 13, color: T.danger }}>{snapshotListError}</div>
          ) : snapshotList.length === 0 ? (
            <div style={{ padding: "40px 20px", textAlign: "center", fontFamily: font.body, fontSize: 13, color: T.textTertiary }}>{t.snapshotPickerEmpty}</div>
          ) : (
            <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, boxShadow: T.shadow, overflow: "hidden", maxWidth: 560 }}>
              {snapshotList.map((s, i) => {
                const d = new Date(s.date);
                const label = isNaN(d.getTime()) ? s.date : `${formatLogDate(localDateStr(d), settings.lang)} · ${d.toLocaleTimeString(settings.lang === "en" ? "en-US" : "pt-BR")}`;
                const sizeKb = (s.size / 1024).toFixed(1);
                return (
                  <button
                    key={s.date}
                    onClick={() => { setShowSnapshotPicker(false); restoreFromSnapshot(s.date); }}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      width: "100%", padding: "12px 16px",
                      background: "none", border: "none", textAlign: "left", cursor: "pointer",
                      borderBottom: i === snapshotList.length - 1 ? "none" : `1px solid ${T.border}`,
                      fontFamily: font.body, fontSize: 13, color: T.text,
                      transition: "background 0.12s",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = T.bgCardHover)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                  >
                    <span>{label}</span>
                    <span style={{ fontFamily: font.mono, fontSize: 11, color: T.textTertiary }}>{sizeKb} KB</span>
                  </button>
                );
              })}
            </div>
          )}
        </Modal>
        <Modal open={showStudyTimeEditModal} onClose={() => setShowStudyTimeEditModal(false)} title={t.editTimeLogs}>
          {(() => {
            const entries = Object.entries(studyTime)
              .filter(([, sec]) => sec > 0)
              .sort((a, b) => b[0].localeCompare(a[0]));
            if (entries.length === 0) {
              return (
                <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: "40px 20px", boxShadow: T.shadow, textAlign: "center", fontFamily: font.body, fontSize: 14, color: T.textTertiary }}>
                  {t.noTimeLogs}
                </div>
              );
            }
            return (
              <>
                <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 12, lineHeight: 1.5 }}>
                  {t.editTimeLogsHint}
                </div>
                <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, boxShadow: T.shadow, overflow: "hidden", maxWidth: 560 }}>
                  {entries.map(([date, sec], idx) => (
                    <div key={date} style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 16px",
                      borderBottom: idx === entries.length - 1 ? "none" : `1px solid ${T.border}`,
                      transition: "background 0.12s",
                    }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = T.bgCardHover)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <div style={{ flex: 1, fontFamily: font.body, fontSize: 14, fontWeight: 500, color: T.text, minWidth: 0 }}>
                        {formatLogDate(date, settings.lang)}
                      </div>
                      <input
                        type="text"
                        inputMode="text"
                        defaultValue={formatTimeInput(sec)}
                        onFocus={(e) => { e.target.style.borderColor = T.borderStrong; e.target.select(); }}
                        onBlur={(e) => {
                          const original = formatTimeInput(sec);
                          const typed = e.target.value.trim();
                          e.target.style.borderColor = T.border;
                          if (typed === original) return; // user didn't actually edit
                          const parsed = parseTimeInput(typed);
                          if (parsed === null) {
                            e.target.value = original;
                            return;
                          }
                          if (parsed === sec) {
                            e.target.value = original;
                            return;
                          }
                          e.target.value = formatTimeInput(parsed);
                          setStudyTimeForDate(date, parsed);
                        }}
                        onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") { e.target.value = formatTimeInput(sec); e.target.blur(); } }}
                        style={{
                          width: 88,
                          padding: "7px 10px",
                          background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                          color: T.text, fontFamily: font.mono, fontSize: 13, outline: "none",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          transition: "border-color 0.15s",
                        }}
                      />
                      <button
                        onClick={() => deleteStudyTimeForDate(date)}
                        aria-label={t.deleteEntry}
                        title={t.deleteEntry}
                        style={{
                          flexShrink: 0,
                          width: 32, height: 32,
                          background: "transparent", border: "1px solid transparent",
                          borderRadius: T.radiusSm,
                          cursor: "pointer",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          transition: "all 0.15s",
                          opacity: 0.55,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = T.dangerBg; e.currentTarget.style.borderColor = "rgba(196,72,62,0.2)"; e.currentTarget.style.opacity = "1"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.opacity = "0.55"; }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={T.danger} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </Modal>
        <Modal open={showSettingsModal} onClose={() => setShowSettingsModal(false)} title={t.settingsTitle}>
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: mobile ? 18 : 28, boxShadow: T.shadow }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
                <div>
                  <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                    {t.dailyGoal}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 12 }}>
                    {t.dailyGoalDesc}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {[5, 10, 20, 30, 50].map((n) => (
                      <button
                        key={n}
                        onClick={() => saveSettings({ ...settings, dailyGoal: n })}
                        style={{
                          padding: mobile ? "8px 12px" : "8px 16px",
                          background: settings.dailyGoal === n ? T.accent : "transparent",
                          border: `1px solid ${settings.dailyGoal === n ? T.accent : T.border}`,
                          borderRadius: T.radiusSm,
                          color: settings.dailyGoal === n ? T.bg : T.textSecondary,
                          fontFamily: font.body, fontSize: 13, fontWeight: 500,
                          cursor: "pointer", transition: "all 0.15s",
                        }}
                        onMouseEnter={(e) => { if (settings.dailyGoal !== n) { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; } }}
                        onMouseLeave={(e) => { if (settings.dailyGoal !== n) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; } }}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ height: 1, background: T.border }} />
                <div>
                  <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                    {t.newCardsPerDay}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 12 }}>
                    {t.newCardsPerDayDesc}
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {[5, 10, 15, 20, 30].map((n) => (
                      <button
                        key={n}
                        onClick={() => saveSettings({ ...settings, newCardsPerDay: n })}
                        style={{
                          padding: mobile ? "8px 12px" : "8px 16px",
                          background: (settings.newCardsPerDay ?? 10) === n ? T.accent : "transparent",
                          border: `1px solid ${(settings.newCardsPerDay ?? 10) === n ? T.accent : T.border}`,
                          borderRadius: T.radiusSm,
                          color: (settings.newCardsPerDay ?? 10) === n ? T.bg : T.textSecondary,
                          fontFamily: font.body, fontSize: 13, fontWeight: 500,
                          cursor: "pointer", transition: "all 0.15s",
                        }}
                        onMouseEnter={(e) => { if ((settings.newCardsPerDay ?? 10) !== n) { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; } }}
                        onMouseLeave={(e) => { if ((settings.newCardsPerDay ?? 10) !== n) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; } }}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ height: 1, background: T.border }} />
                <div>
                  <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                    {t.theme}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 12 }}>
                    {t.themeDesc}
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    {[
                      { id: "light", label: t.themeLight, icon: "sun" },
                      { id: "dark", label: t.themeDark, icon: "moon" },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => saveSettings({ ...settings, theme: opt.id })}
                        style={{
                          flex: 1, padding: "14px 16px",
                          background: settings.theme === opt.id ? T.accentSoft : "transparent",
                          border: `1px solid ${settings.theme === opt.id ? T.borderStrong : T.border}`,
                          borderRadius: T.radiusSm, cursor: "pointer",
                          display: "flex", alignItems: "center", gap: 10,
                          transition: "all 0.15s",
                        }}
                        onMouseEnter={(e) => { if (settings.theme !== opt.id) { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; } }}
                        onMouseLeave={(e) => { if (settings.theme !== opt.id) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; } }}
                      >
                        {opt.icon === "sun" ? (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={T.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="4"/>
                            <path d="M12 5L12 3M12 21L12 19M5 12L2 12 5 12zM22 12L19 12 22 12zM16.9497475 7.05025253L19.0710678 4.92893219 16.9497475 7.05025253zM4.92893219 19.0710678L7.05025253 16.9497475 4.92893219 19.0710678zM16.9497475 16.9497475L19.0710678 19.0710678 16.9497475 16.9497475zM4.92893219 4.92893219L7.05025253 7.05025253 4.92893219 4.92893219z"/>
                          </svg>
                        ) : (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={T.text} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M10.423839,3 C10.1490474,3.80837289 10,4.67486099 10,5.57616098 C10,9.99443898 13.581722,13.576161 18,13.576161 C18.9013,13.576161 19.7677881,13.4271135 20.576161,13.152322 C19.5038921,16.3066875 16.516978,18.576161 13,18.576161 C8.581722,18.576161 5,14.994439 5,10.576161 C5,7.05918297 7.26947343,4.07226889 10.423839,3 Z"/>
                          </svg>
                        )}
                        <span style={{ fontFamily: font.body, fontSize: 14, fontWeight: settings.theme === opt.id ? 600 : 400, color: T.text }}>
                          {opt.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ height: 1, background: T.border }} />
                <div>
                  <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                    {t.language}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 12 }}>
                    {t.languageDesc}
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    {[
                      { id: "pt-BR", label: "Português", icon: "🇧🇷" },
                      { id: "en", label: "English", icon: "🇬🇧" },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => saveSettings({ ...settings, lang: opt.id })}
                        style={{
                          flex: 1, padding: "14px 16px",
                          background: settings.lang === opt.id ? T.accentSoft : "transparent",
                          border: `1px solid ${settings.lang === opt.id ? T.borderStrong : T.border}`,
                          borderRadius: T.radiusSm, cursor: "pointer",
                          display: "flex", alignItems: "center", gap: 10,
                          transition: "all 0.15s",
                        }}
                        onMouseEnter={(e) => { if (settings.lang !== opt.id) { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; } }}
                        onMouseLeave={(e) => { if (settings.lang !== opt.id) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; } }}
                      >
                        <span style={{ fontSize: 20 }}>{opt.icon}</span>
                        <span style={{ fontFamily: font.body, fontSize: 14, fontWeight: settings.lang === opt.id ? 600 : 400, color: T.text }}>
                          {opt.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ height: 1, background: T.border }} />
                <div>
                  <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                    {t.cardOrder}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 12 }}>
                    {t.cardOrderDesc}
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    {[
                      { id: "due", label: t.cardOrderDue, desc: t.cardOrderDueDesc },
                      { id: "newest", label: t.cardOrderNewest, desc: t.cardOrderNewestDesc },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => saveSettings({ ...settings, cardOrder: opt.id })}
                        style={{
                          flex: 1, padding: "14px 16px",
                          background: settings.cardOrder === opt.id ? T.accentSoft : "transparent",
                          border: `1px solid ${settings.cardOrder === opt.id ? T.borderStrong : T.border}`,
                          borderRadius: T.radiusSm, cursor: "pointer", textAlign: "left",
                          transition: "all 0.15s",
                        }}
                        onMouseEnter={(e) => { if (settings.cardOrder !== opt.id) { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; } }}
                        onMouseLeave={(e) => { if (settings.cardOrder !== opt.id) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; } }}
                      >
                        <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: settings.cardOrder === opt.id ? 600 : 400, color: T.text }}>
                          {opt.label}
                        </div>
                        <div style={{ fontFamily: font.body, fontSize: 12, color: T.textTertiary, marginTop: 2 }}>
                          {opt.desc}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ height: 1, background: T.border }} />
                <div>
                  <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                    {t.exportData}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 12 }}>
                    {t.exportDataDesc}
                  </div>
                  <button
                    onClick={() => {
                      const header = "palavra,english,portuguese,due_date,stability,difficulty,reps\n";
                      const rows = cards.map((c) => {
                        const pt = c.phrase
                          ? c.phrase.slice(0, c.keywordStart) + "**" + c.word + "**" + c.phrase.slice(c.keywordEnd)
                          : c.word;
                        return [
                          `"${c.word}"`,
                          `"${(c.translation || "").replace(/"/g, '""')}"`,
                          `"${pt.replace(/"/g, '""')}"`,
                          c.dueDate,
                          (c.stability || 0).toFixed(1),
                          (c.difficulty || 0).toFixed(1),
                          c.reps || 0,
                        ].join(",");
                      }).join("\n");
                      const blob = new Blob([header + rows], { type: "text/csv" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url; a.download = `vocabulario_${today()}.csv`; a.click();
                      URL.revokeObjectURL(url);
                    }}
                    disabled={cards.length === 0}
                    style={{
                      padding: "11px 24px",
                      background: cards.length > 0 ? "transparent" : T.bgInput,
                      border: `1px solid ${cards.length > 0 ? T.border : "transparent"}`,
                      borderRadius: T.radiusSm,
                      color: cards.length > 0 ? T.textSecondary : T.textPlaceholder,
                      fontFamily: font.body, fontSize: 13, fontWeight: 500,
                      cursor: cards.length > 0 ? "pointer" : "default",
                      display: "flex", alignItems: "center", gap: 8,
                      transition: "all 0.15s",
                    }}
                    onMouseEnter={(e) => { if (cards.length > 0) { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; } }}
                    onMouseLeave={(e) => { if (cards.length > 0) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; } }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    {t.exportButton} {cards.length} {cards.length === 1 ? t.cardAs : t.cardsAs}
                  </button>
                </div>
                <div style={{ height: 1, background: T.border }} />
                <div>
                  <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                    {t.exportStudyTime}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 12 }}>
                    {t.exportStudyTimeDesc}
                  </div>
                  <button
                    onClick={() => {
                      const entries = Object.entries(studyTime).filter(([, sec]) => sec > 0).sort((a, b) => a[0].localeCompare(b[0]));
                      const header = "date,minutes,hours,session_count\n";
                      const rows = entries.map(([date, sec]) => {
                        const minutes = Math.round(sec / 60);
                        const hours = (sec / 3600).toFixed(2);
                        return `${date},${minutes},${hours},1`;
                      }).join("\n");
                      const totalSec = entries.reduce((a, [, s]) => a + s, 0);
                      const summary = `\n\ntotal_seconds,${totalSec}\ntotal_minutes,${Math.round(totalSec / 60)}\ntotal_hours,${(totalSec / 3600).toFixed(2)}\n`;
                      const blob = new Blob([header + rows + summary], { type: "text/csv" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url; a.download = `vocabulario_study_time_${today()}.csv`; a.click();
                      URL.revokeObjectURL(url);
                    }}
                    disabled={Object.values(studyTime).every((v) => !v)}
                    style={{
                      padding: "11px 24px",
                      background: Object.values(studyTime).some((v) => v) ? "transparent" : T.bgInput,
                      border: `1px solid ${Object.values(studyTime).some((v) => v) ? T.border : "transparent"}`,
                      borderRadius: T.radiusSm,
                      color: Object.values(studyTime).some((v) => v) ? T.textSecondary : T.textPlaceholder,
                      fontFamily: font.body, fontSize: 13, fontWeight: 500,
                      cursor: Object.values(studyTime).some((v) => v) ? "pointer" : "default",
                      display: "flex", alignItems: "center", gap: 8,
                      transition: "all 0.15s",
                    }}
                    onMouseEnter={(e) => { if (Object.values(studyTime).some((v) => v)) { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; } }}
                    onMouseLeave={(e) => { if (Object.values(studyTime).some((v) => v)) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; } }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    {t.exportStudyTime}
                  </button>
                </div>
                <div style={{ height: 1, background: T.border }} />
                <div>
                  <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                    {t.backupSection}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 12 }}>
                    {t.backupSectionDesc}
                  </div>
                  {(() => {
                    const now = Date.now();
                    const formatAgo = (ts) => {
                      if (!ts) return t.backupHealthNever;
                      const elapsed = now - ts;
                      if (elapsed < 60000) return t.backupHealthJustNow;
                      if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)} ${t.backupHealthMinutesAgo}`;
                      if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)} ${t.backupHealthHoursAgo}`;
                      return `${Math.floor(elapsed / 86400000)} ${t.backupHealthDaysAgo}`;
                    };
                    const manualAge = lastManualBackup ? now - lastManualBackup : Infinity;
                    const manualColor = !lastManualBackup ? T.danger : manualAge > 90 * 86400000 ? T.danger : manualAge > 30 * 86400000 ? T.warning : T.success;
                    const snapAge = lastAutoSnapshot ? now - lastAutoSnapshot : Infinity;
                    const snapColor = !settings.scriptUrl ? T.textTertiary : !lastAutoSnapshot ? T.warning : snapAge > 14 * 86400000 ? T.warning : T.success;
                    const syncColor = !settings.scriptUrl ? T.textTertiary : syncStatus === "synced" ? T.success : syncStatus === "error" ? T.danger : T.textTertiary;
                    const row = (label, value, color) => (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0", borderBottom: `1px solid ${T.border}` }}>
                        <span style={{ fontFamily: font.mono, fontSize: 11, color: T.textTertiary, textTransform: "uppercase", letterSpacing: 1.5 }}>{label}</span>
                        <span style={{ fontFamily: font.mono, fontSize: 12, color: color, fontVariantNumeric: "tabular-nums" }}>{value}</span>
                      </div>
                    );
                    return (
                      <div style={{ background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: "8px 14px", marginBottom: 14 }}>
                        {row(t.backupHealthLastSync, settings.scriptUrl ? (syncStatus === "synced" && lastSynced ? lastSynced : (syncStatus === "syncing" ? "…" : syncStatus === "error" ? "error" : "—")) : "—", syncColor)}
                        {row(t.backupHealthLastSnapshot, settings.scriptUrl ? formatAgo(lastAutoSnapshot) : "—", snapColor)}
                        {row(t.backupHealthLastManual, formatAgo(lastManualBackup), manualColor)}
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0" }}>
                          <span style={{ fontFamily: font.mono, fontSize: 11, color: T.textTertiary, textTransform: "uppercase", letterSpacing: 1.5 }}>{t.backupHealthTotalCards}</span>
                          <span style={{ fontFamily: font.mono, fontSize: 12, color: T.text, fontVariantNumeric: "tabular-nums" }}>{cards.length}</span>
                        </div>
                      </div>
                    );
                  })()}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    <button
                      onClick={exportBackupToFile}
                      style={{
                        padding: "11px 24px", background: "transparent",
                        border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                        color: T.textSecondary, fontFamily: font.body, fontSize: 13, fontWeight: 500,
                        cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                        transition: "all 0.15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                      {t.exportBackup}
                    </button>
                    <button
                      onClick={() => importFileRef.current && importFileRef.current.click()}
                      style={{
                        padding: "11px 24px", background: "transparent",
                        border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                        color: T.textSecondary, fontFamily: font.body, fontSize: 13, fontWeight: 500,
                        cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                        transition: "all 0.15s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
                      </svg>
                      {t.importBackup}
                    </button>
                    {settings.scriptUrl && (
                      <button
                        onClick={() => { setShowSnapshotPicker(true); loadSnapshotList(); }}
                        style={{
                          padding: "11px 24px", background: "transparent",
                          border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                          color: T.textSecondary, fontFamily: font.body, fontSize: 13, fontWeight: 500,
                          cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                          transition: "all 0.15s",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; }}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8"/><polyline points="3 3 3 8 8 8"/>
                        </svg>
                        {t.restoreFromSnapshot}
                      </button>
                    )}
                    <input ref={importFileRef} type="file" accept=".json,application/json" style={{ display: "none" }}
                      onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) importBackupFromFile(f); e.target.value = ""; }}
                    />
                  </div>
                </div>
                <div style={{ height: 1, background: T.border }} />
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={syncStatus === "synced" ? T.success : syncStatus === "error" ? T.danger : T.textTertiary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      {syncStatus === "syncing"
                        ? <><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></>
                        : syncStatus === "synced"
                        ? <polyline points="20 6 9 17 4 12"/>
                        : syncStatus === "error"
                        ? <><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></>
                        : <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></>
                      }
                    </svg>
                    <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text }}>
                      {t.sheetsSync}
                    </div>
                    {syncStatus === "synced" && lastSynced && (
                      <span style={{ fontFamily: font.mono, fontSize: 10, color: T.success, marginLeft: "auto" }}>
                        {t.sheetsLastSync} {lastSynced}
                      </span>
                    )}
                    {syncStatus === "syncing" && (
                      <span style={{ fontFamily: font.mono, fontSize: 10, color: T.textTertiary, marginLeft: "auto" }}>
                        {t.sheetsSyncing}
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 8, lineHeight: 1.5 }}>
                    {t.sheetsSyncDesc}
                  </div>
                  <div style={{ fontFamily: font.body, fontSize: 12, color: T.warning, marginBottom: 12, lineHeight: 1.5 }}>
                    {t.sheetsSyncWarn}
                  </div>
                  {syncStatus === "error" && (
                    <div style={{ background: T.dangerBg, border: `1px solid rgba(196,72,62,0.15)`, borderRadius: T.radiusSm, padding: "10px 14px", marginBottom: 12, fontFamily: font.mono, fontSize: 11, color: T.danger }}>
                      {syncError}
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div>
                      <div style={{ fontFamily: font.mono, fontSize: 10, color: T.textTertiary, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>
                        APPS SCRIPT URL
                      </div>
                      <input
                        type="text"
                        value={scriptUrlInput}
                        onChange={(e) => { setScriptUrlInput(e.target.value); setSheetsSaved(false); }}
                        placeholder="https://script.google.com/macros/s/.../exec"
                        autoComplete="off"
                        style={{ width: "100%", padding: "11px 14px", background: T.bgInput, border: "1px solid transparent", borderRadius: T.radiusSm, color: T.text, fontFamily: font.mono, fontSize: 12, outline: "none", boxSizing: "border-box", transition: "border-color 0.2s" }}
                        onFocus={(e) => { e.target.style.borderColor = T.borderStrong; }}
                        onBlur={(e) => { e.target.style.borderColor = "transparent"; }}
                      />
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <button
                        onClick={async () => {
                          const newSettings = { ...settings, scriptUrl: scriptUrlInput.trim() };
                          await saveSettings(newSettings);
                          setSheetsSaved(true);
                          setTimeout(() => setSheetsSaved(false), 2500);
                          if (scriptUrlInput.trim()) {
                            doSync(scriptUrlInput.trim());
                          }
                        }}
                        disabled={!scriptUrlInput.trim()}
                        style={{
                          flex: 1, padding: "11px 20px",
                          background: sheetsSaved ? T.keywordBg : (scriptUrlInput.trim() ? T.accent : T.bgInput),
                          border: "none", borderRadius: T.radiusSm,
                          color: sheetsSaved ? T.success : (scriptUrlInput.trim() ? T.bg : T.textPlaceholder),
                          fontFamily: font.body, fontSize: 13, fontWeight: 600,
                          cursor: scriptUrlInput.trim() ? "pointer" : "default",
                          transition: "all 0.2s", letterSpacing: 0.3,
                        }}
                        onMouseEnter={(e) => { if (scriptUrlInput.trim() && !sheetsSaved) e.currentTarget.style.opacity = "0.85"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
                      >
                        {sheetsSaved ? t.sheetsSynced : t.sheetsSave}
                      </button>
                      {settings.scriptUrl && (
                        <button
                          onClick={() => { doSync(); }}
                          style={{
                            padding: "11px 16px", background: "transparent", border: `1px solid ${T.border}`,
                            borderRadius: T.radiusSm, color: T.textSecondary, fontFamily: font.body,
                            fontSize: 13, cursor: "pointer", transition: "all 0.15s", whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; }}
                          onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; }}
                        >
                          ↓ {t.sheetsSyncing.replace("...", "")} pull
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ height: 1, background: T.border }} />
                {(() => {
                  const handleSaveKey = () => {
                    const trimmed = apiKeyInput.trim();
                    saveSettings({ ...settings, apiKey: trimmed });
                    setKeySaved(true);
                    setTimeout(() => setKeySaved(false), 2500);
                  };
                  return (
                    <div>
                      <div style={{ fontFamily: font.body, fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
                        {t.apiKey}
                      </div>
                      <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 12, lineHeight: 1.5 }}>
                        {t.apiKeyDesc}
                      </div>
                      <div style={{ display: "flex", gap: 10 }}>
                        <input
                          type="password"
                          value={apiKeyInput}
                          onChange={(e) => { setApiKeyInput(e.target.value); setKeySaved(false); }}
                          placeholder={t.apiKeyPlaceholder}
                          autoComplete="off"
                          style={{
                            flex: 1,
                            padding: "12px 16px",
                            background: T.bgInput,
                            border: "1px solid transparent",
                            borderRadius: T.radiusSm,
                            color: T.text,
                            fontFamily: font.mono,
                            fontSize: 13,
                            outline: "none",
                            transition: "border-color 0.2s",
                          }}
                          onFocus={(e) => { e.target.style.borderColor = T.borderStrong; }}
                          onBlur={(e) => { e.target.style.borderColor = "transparent"; }}
                          onKeyDown={(e) => { if (e.key === "Enter") handleSaveKey(); }}
                        />
                        <button
                          onClick={handleSaveKey}
                          disabled={!apiKeyInput.trim()}
                          style={{
                            padding: "12px 20px",
                            background: keySaved ? T.keywordBg : (apiKeyInput.trim() ? T.accentSoft : T.bgInput),
                            border: `1px solid ${keySaved ? T.success : (apiKeyInput.trim() ? T.borderStrong : T.border)}`,
                            borderRadius: T.radiusSm,
                            color: keySaved ? T.success : (apiKeyInput.trim() ? T.text : T.textPlaceholder),
                            fontFamily: font.body, fontSize: 13, fontWeight: 600,
                            cursor: apiKeyInput.trim() ? "pointer" : "default",
                            transition: "all 0.2s",
                            whiteSpace: "nowrap",
                            flexShrink: 0,
                          }}
                          onMouseEnter={(e) => { if (apiKeyInput.trim() && !keySaved) e.currentTarget.style.opacity = "0.85"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
                        >
                          {keySaved ? t.apiKeySaved : t.add}
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </Modal>
      </div>
      {mobile && (
        <div style={{
          position: "fixed",
          bottom: "calc(env(safe-area-inset-bottom, 0px) + 14px)",
          left: "50%", transform: "translateX(-50%)",
          background: settings.theme === "dark" ? "rgba(30,30,30,0.8)" : "rgba(255,255,255,0.82)",
          borderRadius: 22,
          border: `1px solid ${settings.theme === "dark" ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.05)"}`,
          boxShadow: `0 8px 32px rgba(0,0,0,${settings.theme === "dark" ? "0.4" : "0.1"})`,
          backdropFilter: "blur(24px) saturate(1.8)",
          WebkitBackdropFilter: "blur(24px) saturate(1.8)",
          // Narrow, centered floating bar (Stoic-style). Each tab stacks label over
          // badge. Concentric corners: bar radius 22 − padding 6 = pill radius 16.
          display: "flex", alignItems: "stretch", gap: 4,
          padding: 6,
          zIndex: 1000,
        }}>
          {navItems.map((item) => {
            const active = view === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                style={{
                  minWidth: 88,
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3,
                  background: active ? T.text : "transparent",
                  border: "none",
                  borderRadius: 9999,
                  padding: "7px 12px",
                  cursor: "pointer",
                  WebkitUserSelect: "none", userSelect: "none",
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{
                  fontFamily: font.body, fontSize: 12.5, fontWeight: 600,
                  color: active ? T.bg : T.textSecondary,
                  textTransform: "capitalize", letterSpacing: 0.2, lineHeight: 1.1,
                }}>
                  {item.label}
                </span>
                {item.badge != null && (
                  <span style={{
                    fontFamily: font.mono, fontSize: 9.5, fontWeight: 500,
                    color: active ? T.bg : T.textPlaceholder,
                    opacity: active ? 0.65 : 1,
                    letterSpacing: 0.3, fontVariantNumeric: "tabular-nums", lineHeight: 1.1,
                  }}>
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
