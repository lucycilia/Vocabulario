import { useState, useEffect, useCallback, useRef, useMemo, memo, lazy, Suspense } from "react";
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
const FSRS_W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046,
  1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315,
  2.9898, 0.51655, 0.6621,
];
const FSRS_F = 19.0 / 81.0;
const FSRS_C = -0.5;
const DESIRED_RETENTION = 0.9;
const MAX_INTERVAL = 36500;
// Grades: 1=Forgot, 2=Hard, 3=Good, 4=Easy
const FSRS = {
  // Forgetting curve: R(t, S) = (1 + F * t/S)^C
  retrievability: (t, s) => {
    if (s <= 0) return 0;
    return Math.pow(1.0 + FSRS_F * (t / s), FSRS_C);
  },
  // Interval from desired retention and stability
  interval: (s) => {
    return Math.max(
      1,
      Math.min(
        MAX_INTERVAL,
        Math.round((s / FSRS_F) * (Math.pow(DESIRED_RETENTION, 1.0 / FSRS_C) - 1.0))
      )
    );
  },
  // Initial stability based on first grade
  s0: (grade) => FSRS_W[grade - 1],
  // Initial difficulty based on first grade
  d0: (grade) => {
    return Math.min(10, Math.max(1, FSRS_W[4] - Math.exp(FSRS_W[5] * (grade - 1)) + 1));
  },
  // Update stability on successful recall (grade 2, 3, or 4)
  sSuccess: (d, s, r, grade) => {
    const td = 11.0 - d;
    const ts = Math.pow(s, -FSRS_W[9]);
    const tr = Math.exp(FSRS_W[10] * (1.0 - r)) - 1.0;
    const h = grade === 2 ? FSRS_W[15] : 1.0;
    const b = grade === 4 ? FSRS_W[16] : 1.0;
    const c = Math.exp(FSRS_W[8]);
    const alpha = 1.0 + td * ts * tr * h * b * c;
    return s * alpha;
  },
  // Update stability on failure (grade 1)
  sFail: (d, s, r) => {
    const df = Math.pow(d, -FSRS_W[12]);
    const sf = Math.pow(s + 1, FSRS_W[13]) - 1.0;
    const rf = Math.exp(FSRS_W[14] * (1.0 - r));
    const cf = FSRS_W[11];
    return Math.min(df * sf * rf * cf, s);
  },
  // Update stability
  stability: (d, s, r, grade) => {
    if (grade === 1) return FSRS.sFail(d, s, r);
    return FSRS.sSuccess(d, s, r, grade);
  },
  // Update difficulty
  difficulty: (d, grade) => {
    const deltaD = -FSRS_W[6] * (grade - 3);
    const dp = d + deltaD * ((10.0 - d) / 9.0);
    const newD = FSRS_W[7] * FSRS.d0(4) + (1.0 - FSRS_W[7]) * dp;
    return Math.min(10, Math.max(1, newD));
  },
  // Create a new card
  defaultCard: (word, translation, phrase, keywordStart, keywordEnd) => ({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    word,
    translation,
    phrase,
    keywordStart,
    keywordEnd,
    // FSRS state
    stability: 0,
    difficulty: 0,
    reps: 0,
    dueDate: new Date().toISOString().split("T")[0],
    lastReview: null,
    created: new Date().toISOString().split("T")[0],
    modifiedAt: Date.now(),
  }),
  // Review a card with a grade (1=Forgot, 2=Hard, 3=Good, 4=Easy)
  review: (card, grade) => {
    let { stability: s, difficulty: d, reps } = card;
    if (reps === 0) {
      // First review: initialize S and D from the grade
      s = FSRS.s0(grade);
      d = FSRS.d0(grade);
    } else {
      // Calculate elapsed days since last review
      const lastReviewDate = card.lastReview
        ? new Date(card.lastReview + "T12:00:00")
        : new Date();
      const now = new Date();
      const elapsed = Math.max(0, (now - lastReviewDate) / 86400000);
      // Calculate retrievability at time of review
      const r = FSRS.retrievability(elapsed, s);
      // Update stability and difficulty
      s = FSRS.stability(d, s, r, grade);
      d = FSRS.difficulty(d, grade);
    }
    // Calculate next interval from new stability
    const interval = FSRS.interval(s);
    const due = new Date();
    due.setDate(due.getDate() + interval);
    return {
      ...card,
      stability: s,
      difficulty: d,
      reps: reps + 1,
      dueDate: due.toISOString().split("T")[0],
      lastReview: new Date().toISOString().split("T")[0],
      modifiedAt: Date.now(),
    };
  },
};
// ─── Brazilian Portuguese TTS ───
const speakPT = (text) => {
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
  return window.speechSynthesis.speak(utter);
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
};
const stageLabel = (stage) => {
  const map = { new: "stageNew", learning: "stageLearning", young: "stageYoung", mature: "stageMature", mastered: "stageMastered" };
  return t[map[stage]] || stage;
};
// ─── Import Parsers ───
const looksPortuguese = (text) => /[ãõçêéáíóúâô]/i.test(text);
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
  if (!looksPortuguese(ptSide) && looksPortuguese(enSide)) {
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
// ─── RemNote Due Date Migration Data ───
const REMNOTE_DUE_DATES = [
  {"text": "O atleta usou uma bandagem para proteger o ferimento no joelho", "dueDate": "2026-01-06", "reps": 3},
  {"text": "They discovered a hidden passage behind the bookshelf", "dueDate": "2026-01-06", "reps": 2},
  {"text": "The steep roads of Ouro Preto are a challenge for tourists", "dueDate": "2026-01-06", "reps": 4},
  {"text": "The public program aims to teach literacy to adults who didn't have the opportunity to study (To teach literacy / To make literate)", "dueDate": "2026-01-06", "reps": 3},
  {"text": "It's necessary that you (plural) finish this service soon.", "dueDate": "2026-01-06", "reps": 6},
  {"text": "You are the woman that I've always dreamed of meeting", "dueDate": "2026-01-07", "reps": 3},
  {"text": "She went to look for the information on the official site", "dueDate": "2026-01-07", "reps": 3},
  {"text": "Stop being a pussy and just talk to her", "dueDate": "2026-01-07", "reps": 4},
  {"text": "Since the first meeting, we've (casual) gotten along well and worked in sync.", "dueDate": "2026-01-07", "reps": 7},
  {"text": "When she complains for no reason, it drives me crazy (gets on my nerves)", "dueDate": "2026-01-07", "reps": 4},
  {"text": "Matar dois coelhos com uma cajadada só", "dueDate": "2026-01-08", "reps": 4},
  {"text": "Vocês têm que pagar, quer queiram quer não, caso contrário, chamamos a polícia", "dueDate": "2026-01-08", "reps": 3},
  {"text": "The temperature rise has caused the so-called extreme events, like severe storms.", "dueDate": "2026-01-08", "reps": 4},
  {"text": "É de cair o queixo", "dueDate": "2026-01-08", "reps": 4},
  {"text": "We didn't have a nail to hang the picture.", "dueDate": "2026-01-08", "reps": 10},
  {"text": "O que quer que diga, já ninguém acredita nele", "dueDate": "2026-01-08", "reps": 3},
  {"text": "It's useful that you review the material before the", "dueDate": "2026-01-08", "reps": 5},
  {"text": "Quaisquer que sejam as dificuldades, temos que enfrentá-las", "dueDate": "2026-01-08", "reps": 5},
  {"text": "E ela? A própria", "dueDate": "2026-01-08", "reps": 1},
  {"text": "The software froze unexpectedly during the update (Block / Lock / Jam, depends on context)", "dueDate": "2026-01-09", "reps": 10},
  {"text": "It is important to store the documents in a secure place", "dueDate": "2026-01-09", "reps": 10},
  {"text": "It's easy for you (both) to understand the explanation with this example.", "dueDate": "2026-01-09", "reps": 7},
  {"text": "It's clear that they need help with so much work.", "dueDate": "2026-01-09", "reps": 3},
  {"text": "When buying a TV, check the screen size in inches, as that is how manufacturers list it", "dueDate": "2026-01-09", "reps": 4},
  {"text": "O novo inquilino vai receber as chaves apenas no dia da vigência do contrato", "dueDate": "2026-01-09", "reps": 6},
  {"text": "Ele perguntou a respeito de sua nova proposta.", "dueDate": "2026-01-09", "reps": 5},
  {"text": "Quando ela reclama sem motivo, isso me tira do sério", "dueDate": "2026-01-09", "reps": 3},
  {"text": "My grandmother learned to sew beautiful dresses by hand", "dueDate": "2026-01-10", "reps": 5},
  {"text": "Agora que a empresa está bem das pernas, podemos expandir.", "dueDate": "2026-01-10", "reps": 5},
  {"text": "Por onde quer que venha, vão pegar um trânsito daqueles", "dueDate": "2026-01-10", "reps": 4},
  {"text": "Keeping in mind the time constraints, we need to adjust the schedule", "dueDate": "2026-01-10", "reps": 4},
  {"text": "O software apresentou uma trava inesperada durante a atualização", "dueDate": "2026-01-11", "reps": 6},
  {"text": "Ele faz o que quer que seja para subir na vida", "dueDate": "2026-01-11", "reps": 2},
  {"text": "É preciso que vocês acabem logo esse serviço.", "dueDate": "2026-01-11", "reps": 4},
  {"text": "she's been looking for a job for months (coloquial present perfect continuous)", "dueDate": "2026-01-11", "reps": 7},
  {"text": "Não adianta chorar pelo leite derramado", "dueDate": "2026-01-11", "reps": 4},
  {"text": "Essa cadeira está solta, precisa de um parafuso", "dueDate": "2026-01-11", "reps": 6},
  {"text": "It's likely that he will be late.", "dueDate": "2026-01-12", "reps": 5},
  {"text": "Wherever they go, they always have a blast", "dueDate": "2026-01-12", "reps": 6},
  {"text": "Todo motorista deve verificar os seus pontos", "dueDate": "2026-01-12", "reps": 3},
  {"text": "Regarding the budget, we need to cut expenses. (Very formal)", "dueDate": "2026-01-13", "reps": 15},
  {"text": "Last time we visited, we barely saw any toucans in the reserve", "dueDate": "2026-01-13", "reps": 5},
  {"text": "Use the squeegee to get the water off the floor", "dueDate": "2026-01-14", "reps": 7},
  {"text": "A gente precisa procurar uma solução rápida", "dueDate": "2026-01-14", "reps": 3},
  {"text": "A apneia do sono é hereditária em minha família", "dueDate": "2026-01-14", "reps": 2},
  {"text": "Now, more than ever, we need to act responsibly", "dueDate": "2026-01-15", "reps": 7},
  {"text": "your property may be rented with QuintoAndar or with an estate agent.", "dueDate": "2026-01-15", "reps": 9},
  {"text": "Autism is considered a spectrum disorder", "dueDate": "2026-01-15", "reps": 7},
  {"text": "Eu amo línguas; para mim, estou decodificando o mundo ao meu redor", "dueDate": "2026-01-15", "reps": 2},
  {"text": "É importante armazenar os documentos em um local seguro", "dueDate": "2026-01-16", "reps": 4},
  {"text": "É justo que ele receba o prêmio.", "dueDate": "2026-01-17", "reps": 3},
  {"text": "Sleep apnea is hereditary in my family.", "dueDate": "2026-01-17", "reps": 8},
  {"text": "Tendo em mente o prazo apertado, precisamos trabalhar rápido.", "dueDate": "2026-01-18", "reps": 2},
  {"text": "(Refogar) Para a sopa, refogue cebola picada em manteiga antes de adicionar os legumes", "dueDate": "2026-01-21", "reps": 5},
  {"text": "O lançamento do aplicativo caiu de maduro depois de tanto esforço da equipe.", "dueDate": "2026-01-21", "reps": 4},
  {"text": "It's jaw-dropping", "dueDate": "2026-01-22", "reps": 11},
  {"text": "In the research, we used card sorting to understand the users' mental models.", "dueDate": "2026-01-24", "reps": 9},
  {"text": "É bom que vocês cheguem na hora certa.", "dueDate": "2026-01-25", "reps": 4},
  {"text": "We slept in a bunk bed when we went camping", "dueDate": "2026-01-26", "reps": 7},
  {"text": "O aumento de temperatura tem causado os chamados eventos extremos, como tempestades severas.", "dueDate": "2026-01-27", "reps": 4},
  {"text": "Throughout the year, we will review the results quarterly.", "dueDate": "2026-02-03", "reps": 10},
  {"text": "Eu tenho escalado de vez em quando há alguns anos.", "dueDate": "2026-02-07", "reps": 3},
  {"text": "The app launch was bound to happen after so much effort from the team.", "dueDate": "2026-02-08", "reps": 11},
  {"text": "If I'm not mistaken, the restaurant closes at ten (formal)", "dueDate": "2026-02-08", "reps": 7},
  {"text": "They installed an access ramp for wheelchair users", "dueDate": "2026-02-10", "reps": 11},
  {"text": "To draw a line on the ground with chalk", "dueDate": "2026-02-10", "reps": 4},
  {"text": "I came out at 16", "dueDate": "2026-02-11", "reps": 9},
  {"text": "That technology is light-years ahead of the competition.", "dueDate": "2026-02-12", "reps": 11},
  {"text": "Everyone feels comfortable here. (two words, not \"tudo mundo\")", "dueDate": "2026-02-13", "reps": 4},
  {"text": "do you know how to take care of plants?", "dueDate": "2026-02-14", "reps": 3},
  {"text": "My neighborhood went through a process of gentrification in recent years", "dueDate": "2026-02-15", "reps": 5},
  {"text": "As roupas novas tinham várias manchas de tinta após a reforma.", "dueDate": "2026-02-19", "reps": 5},
  {"text": "Relax, I'm kidding, don't take it seriously!", "dueDate": "2026-02-19", "reps": 10},
  {"text": "He is preparing for the university entrance exam and is attending an intensive preparatory course on weekends", "dueDate": "2026-02-20", "reps": 7},
  {"text": "Is it her? In the flesh", "dueDate": "2026-02-20", "reps": 5},
  {"text": "He asked about your new proposal.", "dueDate": "2026-02-21", "reps": 9},
  {"text": "The new tenant will only receive the keys on the contract's effective date", "dueDate": "2026-02-23", "reps": 11},
  {"text": "My nephew fell and now he is toothless.", "dueDate": "2026-02-24", "reps": 8},
  {"text": "Até onde eu sei, ninguém foi informado sobre a mudança.", "dueDate": "2026-02-24", "reps": 5},
  {"text": "To scratch the car's paint", "dueDate": "2026-02-26", "reps": 9},
  {"text": "To scratch the surface of something", "dueDate": "2026-02-27", "reps": 6},
  {"text": "He's still looking for work", "dueDate": "2026-02-27", "reps": 4},
  {"text": "We like to bake sourdough bread at home using my dad's recipe from Malta", "dueDate": "2026-02-28", "reps": 3},
  {"text": "To swipe", "dueDate": "2026-03-01", "reps": 4},
  {"text": "Wherever they go, they're hailed", "dueDate": "2026-03-02", "reps": 11},
  {"text": "Apagar", "dueDate": "2026-03-02", "reps": 5},
  {"text": "Minha avó aprendeu a costurar belos vestidos à mão", "dueDate": "2026-03-03", "reps": 3},
  {"text": "As far as I know, no one was informed about the", "dueDate": "2026-03-04", "reps": 7},
  {"text": "To slide on the ice", "dueDate": "2026-03-04", "reps": 4},
  {"text": "To immerse oneself in work", "dueDate": "2026-03-07", "reps": 5},
  {"text": "Companies should avoid dark patterns that deceive users", "dueDate": "2026-03-07", "reps": 9},
  {"text": "Let's go to the beach, whether it rains or is sunny", "dueDate": "2026-03-09", "reps": 9},
  {"text": "Os enfermeiros estavam na linha de frente durante a pandemia", "dueDate": "2026-03-09", "reps": 2},
  {"text": "He's a bit controlling with money", "dueDate": "2026-03-10", "reps": 7},
  {"text": "Ela sempre usa um rabo de cavalo pra malhar", "dueDate": "2026-03-12", "reps": 8},
  {"text": "Ao comprar a TV, verifique o tamanho da tela em polegadas, pois é assim que os fabricantes listam", "dueDate": "2026-03-12", "reps": 2},
  {"text": "É normal que haja diferenças culturais.", "dueDate": "2026-03-12", "reps": 2},
  {"text": "O comediante deixou a plateia em êxtase.", "dueDate": "2026-03-13", "reps": 2},
  {"text": "O carro deslizou na pista molhada –", "dueDate": "2026-03-15", "reps": 4},
  {"text": "To erase the board", "dueDate": "2026-03-16", "reps": 11},
  {"text": "we need to look for a quick solution", "dueDate": "2026-03-17", "reps": 3},
  {"text": "No show de stand-up, o comediante matou a pau.", "dueDate": "2026-03-18", "reps": 2},
  {"text": "He spoke (barely) some English on the trip.", "dueDate": "2026-03-20", "reps": 4},
  {"text": "To blow out the candle", "dueDate": "2026-03-20", "reps": 5},
  {"text": "No decorrer do ano, vamos revisar os resultados trimestralmente.", "dueDate": "2026-03-24", "reps": 9},
  {"text": "To use an eraser to fix a mistake", "dueDate": "2026-03-26", "reps": 6},
  {"text": "Who gives a crap about that?", "dueDate": "2026-03-26", "reps": 11},
  {"text": "Windscreen wiper", "dueDate": "2026-03-28", "reps": 5},
  {"text": "I love languages; for me, I'm decoding the world around me.", "dueDate": "2026-03-29", "reps": 4},
  {"text": "To dive into the swimming pool", "dueDate": "2026-03-30", "reps": 4},
  {"text": "Quem quer que ligue, diga que eu não estou", "dueDate": "2026-03-31", "reps": 5},
  {"text": "o locador | o proprietário", "dueDate": "2026-03-31", "reps": 5},
  {"text": "Ele arranhou um pouco de inglês na viagem", "dueDate": "2026-04-04", "reps": 6},
  {"text": "Usar a borracha para apagar um erro", "dueDate": "2026-04-04", "reps": 4},
  {"text": "Male cats are more cuddly and affectionate than", "dueDate": "2026-04-06", "reps": 7},
  {"text": "To turn on the windshield wipers in the rain", "dueDate": "2026-04-07", "reps": 5},
  {"text": "Apagar da memória", "dueDate": "2026-04-07", "reps": 5},
  {"text": "It's no use crying over spilled milk", "dueDate": "2026-04-07", "reps": 6},
  {"text": "To get deeply into a book", "dueDate": "2026-04-08", "reps": 4},
  {"text": "I've been climbing on and off for a few years.", "dueDate": "2026-04-09", "reps": 3},
  {"text": "To erase the past/move on", "dueDate": "2026-04-09", "reps": 10},
  {"text": "É fundamental reduzir a carga cognitiva do usuário em cada etapa do processo", "dueDate": "2026-04-09", "reps": 5},
  {"text": "If it tastes like X, I won't like it", "dueDate": "2026-04-10", "reps": 4},
  {"text": "When I realized I almost missed the flight, I thought: \"What a mess it could have been\"", "dueDate": "2026-04-14", "reps": 6},
  {"text": "This topic is self-explanatory and requires no further explanation", "dueDate": "2026-04-14", "reps": 8},
  {"text": "Para onde quer que vá, sempre se divertem à beça", "dueDate": "2026-04-16", "reps": 3},
  {"text": "Pincel", "dueDate": "2026-04-16", "reps": 4},
  {"text": "It is essential to reduce the user's cognitive load at each stage of the process", "dueDate": "2026-04-16", "reps": 2},
  {"text": "The weather has been great", "dueDate": "2026-04-18", "reps": 7},
  {"text": "To use a fine brush to paint details", "dueDate": "2026-04-19", "reps": 3},
  {"text": "Ligar o limpador de para-brisa na chuva", "dueDate": "2026-04-20", "reps": 4},
  {"text": "Where's the screwdriver?", "dueDate": "2026-04-22", "reps": 9},
  {"text": "A floresta parecia calma durante o dia, mas à noite se tornava assustadora, cheia de sons estranhos.", "dueDate": "2026-04-24", "reps": 4},
  {"text": "Learning a new language is like decoding a secret code", "dueDate": "2026-04-26", "reps": 10},
  {"text": "That science fiction movie was more my vibe", "dueDate": "2026-04-27", "reps": 10},
  {"text": "Riscar o chão com giz", "dueDate": "2026-04-28", "reps": 3},
  {"text": "Makeup brush", "dueDate": "2026-05-02", "reps": 4},
  {"text": "At the stand-up show, the comedian nailed it.", "dueDate": "2026-05-03", "reps": 11},
  {"text": "This chair is wobbly, it needs a screw", "dueDate": "2026-05-03", "reps": 6},
  {"text": "Meu gato me arranhou", "dueDate": "2026-05-05", "reps": 4},
  {"text": "Mergulhar de cabeça em um projeto", "dueDate": "2026-05-10", "reps": 4},
  {"text": "Pelo que eu saiba, a reunião está marcada para amanhã de manhã", "dueDate": "2026-05-14", "reps": 4},
  {"text": "To cross out a name from the list", "dueDate": "2026-05-14", "reps": 5},
  {"text": "Era para ele ter embarcado há duas horas, mas seu voo foi cancelado", "dueDate": "2026-05-22", "reps": 3},
  {"text": "Quer saiba a resposta quer não, tem que esperar a sua vez", "dueDate": "2026-05-24", "reps": 4},
  {"text": "I'd give anything to not have a test tomorrow", "dueDate": "2026-05-25", "reps": 3},
  {"text": "Ana is not coming to work. She's been ill", "dueDate": "2026-05-30", "reps": 5},
  {"text": "É possível que hoje ainda chova", "dueDate": "2026-06-03", "reps": 4},
  {"text": "She always knew that one day she would open her own business.", "dueDate": "2026-06-13", "reps": 13},
  {"text": "É necessário que ela aprenda uma língua.", "dueDate": "2026-06-16", "reps": 4},
  {"text": "Arranhar a superfície de algo", "dueDate": "2026-06-17", "reps": 5},
  {"text": "To change the windshield wiper rubber", "dueDate": "2026-06-18", "reps": 6},
  {"text": "Apagar o quadro", "dueDate": "2026-06-27", "reps": 6},
  {"text": "If I'm not wrong, she departs tomorrow morning", "dueDate": "2026-06-27", "reps": 11},
  {"text": "O autismo é considerado um transtorno do espectro", "dueDate": "2026-06-29", "reps": 5},
  {"text": "The nurses were on the front line during the pandemic", "dueDate": "2026-07-01", "reps": 7},
  {"text": "Ele ainda está procurando trabalho", "dueDate": "2026-07-09", "reps": 3},
  {"text": "Now that the company is doing well, we can expand.", "dueDate": "2026-07-14", "reps": 4},
  {"text": "O tempo tem estado ótimo", "dueDate": "2026-07-20", "reps": 6},
  {"text": "Riscar", "dueDate": "2026-07-26", "reps": 4},
  {"text": "É uma pena que eles não possam vir.", "dueDate": "2026-07-27", "reps": 5},
  {"text": "Eles instalaram uma rampa de acesso para cadeirantes", "dueDate": "2026-07-28", "reps": 2},
  {"text": "Passar a borracha no passado", "dueDate": "2026-07-28", "reps": 3},
  {"text": "Na rodovia, pagamos pedágio", "dueDate": "2026-07-29", "reps": 7},
  {"text": "É melhor que você consulte um médico.", "dueDate": "2026-08-11", "reps": 6},
  {"text": "To dive headfirst into a project", "dueDate": "2026-08-19", "reps": 5},
  {"text": "Cadê a chave de fenda?", "dueDate": "2026-08-24", "reps": 6},
  {"text": "Não é verdade que ela mente o tempo todo.", "dueDate": "2026-08-26", "reps": 6},
  {"text": "It's not true that she lies all the time.", "dueDate": "2026-08-28", "reps": 10},
  {"text": "To dip the brush in paint", "dueDate": "2026-08-29", "reps": 5},
  {"text": "After reading the summary, I understood the premise of the book immediately", "dueDate": "2026-09-08", "reps": 7},
  {"text": "Mergulhar na piscina", "dueDate": "2026-09-14", "reps": 3},
  {"text": "Aprender um novo idioma é como decodificar um código secreto", "dueDate": "2026-09-23", "reps": 4},
  {"text": "To erase", "dueDate": "2026-09-26", "reps": 3},
  {"text": "É aconselhável que vocês descansem todos os dias.", "dueDate": "2026-10-01", "reps": 9},
  {"text": "Os gatos machos são mais fofos e carinhosos do que as gatas fêmeas, que geralmente são mais independentes", "dueDate": "2026-10-03", "reps": 4},
  {"text": "To dive into the sea", "dueDate": "2026-10-14", "reps": 4},
  {"text": "Mergulhar no trabalho", "dueDate": "2026-10-22", "reps": 3},
  {"text": "Você sabe cuidar de plantas?", "dueDate": "2026-10-24", "reps": 2},
  {"text": "A paint brush", "dueDate": "2026-10-28", "reps": 3},
  {"text": "Usar um pincel fino para pintar detalhes", "dueDate": "2026-10-30", "reps": 3},
  {"text": "My cat scratched me", "dueDate": "2026-10-31", "reps": 3},
  {"text": "Arranhar a pintura do carro", "dueDate": "2026-11-03", "reps": 4},
  {"text": "Pincel de maquiagem", "dueDate": "2026-11-04", "reps": 3},
  {"text": "The car skidded on the wet road/lane", "dueDate": "2026-11-10", "reps": 7},
  {"text": "Mergulhar", "dueDate": "2026-11-14", "reps": 4},
  {"text": "Deslizar", "dueDate": "2026-11-15", "reps": 3},
  {"text": "Este tópico é autoexplicativo e não requer mais explicações", "dueDate": "2026-11-18", "reps": 5},
  {"text": "Daria tudo para não ter prova amanhã", "dueDate": "2026-11-27", "reps": 4},
  {"text": "Mergulhar o pincel na tinta", "dueDate": "2026-11-29", "reps": 4},
  {"text": "To scratch", "dueDate": "2026-11-30", "reps": 4},
  {"text": "Apagar a vela", "dueDate": "2026-12-03", "reps": 5},
  {"text": "Apagar as luzes", "dueDate": "2026-12-04", "reps": 3},
  {"text": "An eraser", "dueDate": "2026-12-06", "reps": 7},
  {"text": "Ele está se preparando para o vestibular e faz um cursinho intensivo aos finais de semana", "dueDate": "2026-12-13", "reps": 2},
  {"text": "Para-brisa", "dueDate": "2026-12-23", "reps": 4},
  {"text": "To erase from memory", "dueDate": "2027-01-08", "reps": 4},
  {"text": "Trocar a borracha do para-brisa", "dueDate": "2027-01-08", "reps": 4},
  {"text": "To swipe your finger on the phone screen", "dueDate": "2027-01-17", "reps": 7},
  {"text": "To dive (Scooba diving)", "dueDate": "2027-01-25", "reps": 3},
  {"text": "A Ana não vem trabalhar. Tem estado doente", "dueDate": "2027-02-14", "reps": 2},
  {"text": "O oftalmologista me deu uma receita de óculos depois do exame", "dueDate": "2027-02-23", "reps": 2},
  {"text": "Mergulhar em um livro", "dueDate": "2027-02-23", "reps": 5},
  {"text": "I need to schedule an appointment with the ophthalmologist to check my vision", "dueDate": "2027-02-28", "reps": 3},
  {"text": "I need to cross this item off the list", "dueDate": "2027-03-04", "reps": 4},
  {"text": "To scratch out", "dueDate": "2027-03-14", "reps": 5},
  {"text": "Riscar um nome da lista", "dueDate": "2027-03-14", "reps": 5},
  {"text": "Por onde quer que passem, são aclamados", "dueDate": "2027-04-15", "reps": 2},
  {"text": "The ophthalmologist gave me a glasses prescription after the exam", "dueDate": "2027-05-12", "reps": 3},
  {"text": "To turn off the lights", "dueDate": "2027-06-30", "reps": 6},
  {"text": "How about a coffee before the meeting?", "dueDate": "2027-07-09", "reps": 3},
  {"text": "Meu sobrinho caiu e agora está banguelo.", "dueDate": "2027-07-09", "reps": 3},
  {"text": "Preciso marcar uma consulta com o oftalmologista para checar minha visão", "dueDate": "2027-10-03", "reps": 3},
  {"text": "Arranhar", "dueDate": "2027-11-16", "reps": 4},
  {"text": "Preciso riscar esse item da lista", "dueDate": "2028-01-02", "reps": 5},
  {"text": "Deslizar o dedo na tela do celular", "dueDate": "2028-02-14", "reps": 3},
  {"text": "Mergulhar no mar", "dueDate": "2028-02-19", "reps": 4},
  {"text": "Tendo em mente as limitações de tempo, precisamos ajustar o cronograma", "dueDate": "2028-04-15", "reps": 3},
  {"text": "Deslizar no gelo", "dueDate": "2028-10-03", "reps": 3},
  {"text": "Na pesquisa, utilizamos a classificação de cartões para entender os modelos mentais dos usuários", "dueDate": "2028-11-03", "reps": 2},
];
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
// Apply RemNote due dates and last practiced dates to cards (one-time migration)
// Returns { cards, practiceDayCounts } where practiceDayCounts maps date -> review count
const applyRemnoteDueDates = (cards) => {
  // Build due date lookup: normalize text -> {dueDate, reps}
  const dueLookup = new Map();
  for (const entry of REMNOTE_DUE_DATES) {
    dueLookup.set(entry.text.toLowerCase().trim(), { dueDate: entry.dueDate, reps: entry.reps });
  }
  // Build last practiced lookup: normalize text -> lastPracticed date
  const practicedLookup = new Map();
  for (const entry of REMNOTE_LAST_PRACTICED) {
    practicedLookup.set(entry.text.toLowerCase().trim(), entry.lastPracticed);
  }
  let updated = 0;
  const practiceDayCounts = {};
  const result = cards.map(card => {
    // Try matching against word, translation, and phrase
    const candidates = [card.word, card.translation, card.phrase].filter(Boolean);
    for (const field of candidates) {
      const key = field.toLowerCase().trim();
      const dueMatch = dueLookup.get(key);
      const lastPracticed = practicedLookup.get(key);
      if (dueMatch) {
        updated++;
        // Use real lastReview if available, otherwise fall back to today
        const reviewDate = lastPracticed || new Date().toISOString().split("T")[0];
        // Calculate stability from real interval: dueDate - lastReview
        const dueMs = new Date(dueMatch.dueDate + "T12:00:00");
        const reviewMs = new Date(reviewDate + "T12:00:00");
        const intervalDays = Math.max(1, Math.round((dueMs - reviewMs) / 86400000));
        // In FSRS: stability ≈ interval
        const stability = Math.max(1, intervalDays);
        // Estimate difficulty from reps (more reps + longer intervals = easier)
        const difficulty = Math.min(10, Math.max(1, 7 - dueMatch.reps * 0.3));
        // Track practice day for heatmap + activity chart
        if (lastPracticed) {
          practiceDayCounts[lastPracticed] = (practiceDayCounts[lastPracticed] || 0) + 1;
        }
        return {
          ...card,
          dueDate: dueMatch.dueDate,
          reps: dueMatch.reps,
          stability,
          difficulty,
          lastReview: reviewDate,
          modifiedAt: Date.now(),
        };
      }
    }
    return card;
  });
  if (updated > 0) console.log(`[RemNote migration] Updated ${updated} cards with due dates, last practiced, and FSRS state`);
  return { cards: result, practiceDayCounts };
};
// ─── Date Helpers ───
const today = () => new Date().toISOString().split("T")[0];
const normalizeDate = (v) => {
  if (!v) return "";
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return "";
};
const getDaysInYear = (year) => {
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  const days = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d).toISOString().split("T")[0]);
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
    keyword: "#2D6A4F",
    keywordBg: "rgba(45,106,79,0.08)",
    success: "#2D6A4F",
    danger: "#C4483E",
    dangerBg: "rgba(196,72,62,0.06)",
    warning: "#B5860B",
    warningBg: "rgba(181,134,11,0.06)",
    shadow: "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.02)",
    shadowLg: "0 4px 20px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)",
    radius: 16,
    radiusSm: 9999,
    radiusPill: 9999,
    heatEmpty: "#E8E8E8",
    heat1: "#CCCCCC",
    heat2: "#8FB59A",
    heat3: "#5A9E6F",
    heat4: "#2D6A4F",
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
    keyword: "#6FCF97",
    keywordBg: "rgba(111,207,151,0.12)",
    success: "#6FCF97",
    danger: "#F28B82",
    dangerBg: "rgba(242,139,130,0.1)",
    warning: "#F5C563",
    warningBg: "rgba(245,197,99,0.1)",
    shadow: "0 1px 4px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)",
    shadowLg: "0 4px 24px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.3)",
    radius: 16,
    radiusSm: 9999,
    radiusPill: 9999,
    heatEmpty: "rgba(255,255,255,0.06)",
    heat1: "#1A3A2A",
    heat2: "#2D6A4F",
    heat3: "#40916C",
    heat4: "#6FCF97",
  },
};
let T = themes.light;
const font = {
  display: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  body: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  mono: "'Helvetica Neue', Helvetica, Arial, sans-serif",
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
    tapToReveal: "toque para revelar",
    listenPronunciation: "ouvir pronúncia",
    skip: "Pular",
    forgot: "Esqueci",
    partiallyRecalled: "Parcialmente",
    recalledWithEffort: "Com esforço",
    easilyRecalled: "Fácil",
    import: "importar",
    newWord: "+ novo",
    close: "fechar",
    noWordsYet: "nenhuma palavra adicionada ainda",
    newCard: "Novo",
    today: "Hoje",
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
    headerPalavra: "Palavra",
    headerEnglish: "Inglês",
    headerPortuguese: "Português",
    headerDue: "Revisão",
    headerStage: "Estágio",
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
    cardOrderRandom: "Aleatório",
    cardOrderRandomDesc: "Ordem diferente cada dia",
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
    stageBreakdown: "Progresso por estágio",
    studyActivity: "Atividade de estudo",
    studyActivityDesc: "Palavras revisadas por dia",
    wordsReviewed: "Palavras revisadas",
    thisWeek: "Esta semana",
    thisMonth: "Este mês",
    thisYear: "Este ano",
    chat: "conversar",
    chatNoDue: "Nenhuma palavra para revisar hoje",
    chatNoDueDesc: "Volte quando tiver palavras em dia para praticar conversando.",
    chatNoKey: "Chave de API não configurada",
    chatNoKeyDesc: "Adicione sua chave de API Gemini (Google) nos ajustes para usar o modo de conversa. É grátis em aistudio.google.com.",
    chatGoToSettings: "Ir para ajustes",
    chatReady: "Pronto para conversar",
    chatReadyDesc: "A IA vai criar frases novas com as suas palavras do dia. Use as palavras naturalmente na conversa.",
    chatStart: "Começar conversa",
    chatInputPlaceholder: "Escreva sua resposta em português...",
    chatSend: "Enviar",
    chatWordsUsed: "palavras praticadas",
    chatWordUsed: "palavra praticada",
    chatNewSession: "Nova sessão",
    chatThinking: "pensando...",
    chatSessionTitle: "Sessão de conversa",
    apiKey: "Chave de API Gemini",
    apiKeyDesc: "Chave gratuita do Google AI Studio (aistudio.google.com). Armazenada só no seu dispositivo.",
    apiKeyPlaceholder: "AIza...",
    apiKeySaved: "Chave salva ✓",
    sheetsSync: "Sincronização Google Sheets",
    sheetsSyncDesc: "Mantenha seus cartões sincronizados em todos os dispositivos via Google Sheets. Cole a URL do Apps Script abaixo.",
    sheetsSave: "Salvar e sincronizar",
    sheetsSyncing: "sincronizando...",
    sheetsSynced: "Sincronizado ✓",
    sheetsError: "Erro de sincronização",
    sheetsLastSync: "Última sincronização",
    enToPt: "EN → PT",
    ptToEn: "PT → EN",
    searchPlaceholder: "buscar palavras ou frases...",
    groupByStage: "agrupar",
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
    tapToReveal: "tap to reveal",
    listenPronunciation: "listen to pronunciation",
    skip: "Skip",
    forgot: "Forgot",
    partiallyRecalled: "Partially recalled",
    recalledWithEffort: "Recalled with effort",
    easilyRecalled: "Easily recalled",
    import: "import",
    newWord: "+ new",
    close: "close",
    noWordsYet: "no words added yet",
    newCard: "New",
    today: "Today",
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
    headerPalavra: "Keyword",
    headerEnglish: "English",
    headerPortuguese: "Portuguese",
    headerDue: "Due",
    headerStage: "Stage",
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
    cardOrderRandom: "Random",
    cardOrderRandomDesc: "Different order each day",
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
    stageBreakdown: "Progress by stage",
    studyActivity: "Study activity",
    studyActivityDesc: "Words reviewed per day",
    wordsReviewed: "Words reviewed",
    thisWeek: "This week",
    thisMonth: "This month",
    thisYear: "This year",
    chat: "chat",
    chatNoDue: "No words due today",
    chatNoDueDesc: "Come back when you have words due to practise in conversation.",
    chatNoKey: "API key not configured",
    chatNoKeyDesc: "Add your Gemini API key (Google) in settings to use conversation mode. It's free at aistudio.google.com.",
    chatGoToSettings: "Go to settings",
    chatReady: "Ready to chat",
    chatReadyDesc: "The AI will create new sentences using your due words. Use them naturally in the conversation.",
    chatStart: "Start conversation",
    chatInputPlaceholder: "Write your reply in Portuguese...",
    chatSend: "Send",
    chatWordsUsed: "words practised",
    chatWordUsed: "word practised",
    chatNewSession: "New session",
    chatThinking: "thinking...",
    chatSessionTitle: "Conversation session",
    apiKey: "Gemini API Key",
    apiKeyDesc: "Free key from Google AI Studio (aistudio.google.com). Stored only on your device.",
    apiKeyPlaceholder: "AIza...",
    apiKeySaved: "Key saved ✓",
    sheetsSync: "Google Sheets Sync",
    sheetsSyncDesc: "Keep your cards synced across all devices via Google Sheets. Paste your Apps Script URL below.",
    sheetsSave: "Save & sync",
    sheetsSyncing: "syncing...",
    sheetsSynced: "Synced ✓",
    sheetsError: "Sync error",
    sheetsLastSync: "Last synced",
    enToPt: "EN → PT",
    ptToEn: "PT → EN",
    searchPlaceholder: "search words or phrases...",
    groupByStage: "group",
  },
};
let t = i18n["pt-BR"];
// ─── Heatmap Component ───
function CalendarHeatmap({ practiceDays, year, onYearChange }) {
  const [tooltip, setTooltip] = useState(null);
  const gridRef = useRef(null);
  const days = getDaysInYear(year);
  const maxCount = Math.max(1, ...Object.values(practiceDays).filter(Boolean));
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
    const count = practiceDays[day] || 0;
    if (count === 0) return T.heatEmpty;
    const intensity = Math.min(count / Math.max(maxCount, 4), 1);
    if (intensity <= 0.25) return T.heat1;
    if (intensity <= 0.5) return T.heat2;
    if (intensity <= 0.75) return T.heat3;
    return T.heat4;
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
  const totalDays = Object.values(practiceDays).filter((v) => v > 0).length;
  const currentStreak = (() => {
    let streak = 0;
    let d = new Date();
    while (true) {
      const ds = d.toISOString().split("T")[0];
      if (practiceDays[ds] && practiceDays[ds] > 0) { streak++; d.setDate(d.getDate() - 1); } else break;
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
          {currentStreak > 0 && (
            <span style={{ fontFamily: font.mono, fontSize: 11, color: T.textTertiary }}>
              {currentStreak} {t.daysInARow}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => onYearChange(year - 1)} style={{
            background: T.bgInput, border: `1px solid ${T.borderStrong}`, color: T.text,
            borderRadius: 9999, padding: "6px 12px", cursor: "pointer", fontFamily: font.body,
            fontSize: 14, fontWeight: 500, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 0.15s",
          }}
            onMouseEnter={(e) => { e.currentTarget.style.background = T.bgCardHover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = T.bgInput; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={T.text} strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <span style={{ fontFamily: font.body, fontSize: 15, fontWeight: 600, color: T.text, minWidth: 48, textAlign: "center" }}>{year}</span>
          <button onClick={() => onYearChange(year + 1)} style={{
            background: T.bgInput, border: `1px solid ${T.borderStrong}`, color: T.text,
            borderRadius: 9999, padding: "6px 12px", cursor: "pointer", fontFamily: font.body,
            fontSize: 14, fontWeight: 500, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center",
            transition: "background 0.15s",
          }}
            onMouseEnter={(e) => { e.currentTarget.style.background = T.bgCardHover; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = T.bgInput; }}
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
                  cursor: day && (practiceDays[day] || 0) > 0 ? "pointer" : "default",
                }}
                onMouseEnter={(e) => {
                  if (!day) return;
                  const count = practiceDays[day] || 0;
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
        {[T.heatEmpty, T.heat1, T.heat2, T.heat3, T.heat4].map((c, i) => (
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
// ─── Phrase Display ───
function PhraseDisplay({ phrase, keywordStart, keywordEnd, size = "normal" }) {
  if (!phrase) return null;
  const before = phrase.slice(0, keywordStart);
  const keyword = phrase.slice(keywordStart, keywordEnd);
  const after = phrase.slice(keywordEnd);
  const fs = size === "large" ? 20 : size === "practice" ? 24 : 14;
  const textColor = size === "practice" ? T.text : T.textSecondary;
  return (
    <span style={{ fontSize: fs, lineHeight: 1.7, fontFamily: font.body, fontWeight: 400 }}>
      <span style={{ color: textColor }}>{before}</span>
      <span style={{ color: T.keyword, fontWeight: 700, background: T.keywordBg, padding: "2px 4px", borderRadius: 4 }}>{keyword}</span>
      <span style={{ color: textColor }}>{after}</span>
    </span>
  );
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
// ─── Practice Card ───
function PracticeCard({ card, onReview, onSkip, totalDue, studyDirection }) {
  const mobile = useIsMobile();
  const [flipped, setFlipped] = useState(false);
  const [exiting, setExiting] = useState(false);
  const handleReview = (quality) => {
    if (quality === 0) {
      setExiting(true);
      setTimeout(() => { onSkip(card.id); setFlipped(false); setExiting(false); }, 280);
      return;
    }
    setExiting(true);
    setTimeout(() => { onReview(card.id, quality); setFlipped(false); setExiting(false); }, 280);
  };
  const qualityButtons = [
    { q: 0, label: t.skip, emoji: "⏭️", color: T.textTertiary },
    { q: 1, label: t.forgot, emoji: "❌", color: T.danger },
    { q: 2, label: t.partiallyRecalled, emoji: "😬", color: T.warning },
    { q: 3, label: t.recalledWithEffort, emoji: "😄", color: T.success },
    { q: 4, label: t.easilyRecalled, emoji: "👑", color: T.textSecondary },
  ];
  return (
    <div style={{ opacity: exiting ? 0 : 1, transform: exiting ? "translateY(-16px)" : "translateY(0)", transition: "all 0.28s ease" }}>
      <div
        onClick={() => { if (!flipped) { setFlipped(true); } }}
        style={{
          background: T.bgCard,
          border: `1px solid ${T.border}`,
          borderRadius: T.radius,
          padding: mobile ? "36px 20px" : "56px 40px",
          cursor: flipped ? "default" : "pointer",
          minHeight: mobile ? 180 : 240,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          boxShadow: T.shadowLg,
          transition: "all 0.3s",
        }}
        onMouseEnter={(e) => { if (!flipped) e.currentTarget.style.borderColor = T.borderStrong; }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; }}
      >
        {!flipped ? (
          <>
            <div style={{ fontFamily: font.mono, fontSize: 10, color: T.textTertiary, textTransform: "uppercase", letterSpacing: 2.5, marginBottom: 20 }}>
              {studyDirection === "en-pt" ? t.english : t.portuguese}
            </div>
            {studyDirection === "en-pt" ? (
              <div style={{ fontFamily: font.display, fontSize: 24, fontWeight: 400, color: T.text, lineHeight: 1.4, maxWidth: mobile ? "100%" : 760 }}>
                {card.translation}
              </div>
            ) : (
              <>
                {card.phrase ? (
                  <div style={{ maxWidth: mobile ? "100%" : 760 }}>
                    <PhraseDisplay phrase={card.phrase} keywordStart={card.keywordStart} keywordEnd={card.keywordEnd} size="practice" />
                  </div>
                ) : (
                  <div style={{ fontFamily: font.display, fontSize: 24, fontWeight: 400, color: T.text, lineHeight: 1.4, maxWidth: mobile ? "100%" : 760 }}>
                    {card.word}
                  </div>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); speakPT(card.phrase || card.word); }}
                  style={{
                    marginTop: 24, background: T.accentSoft, border: `1px solid ${T.border}`,
                    borderRadius: 24, padding: "9px 22px", color: T.textSecondary,
                    fontFamily: font.body, fontSize: 13, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 8, transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.accentSoft; }}
                >
                  <SpeakerIcon size={16} color={T.textSecondary} />
                  {t.listenPronunciation}
                </button>
              </>
            )}
            <div style={{ fontFamily: font.mono, fontSize: 11, color: T.textPlaceholder, marginTop: 32, letterSpacing: 0.5 }}>
              {t.tapToReveal}
            </div>
          </>
        ) : (
          <>
            <div style={{ fontFamily: font.mono, fontSize: 10, color: T.keyword, textTransform: "uppercase", letterSpacing: 2.5, marginBottom: 20 }}>
              {studyDirection === "en-pt" ? t.portuguese : t.english}
            </div>
            {studyDirection === "en-pt" ? (
              <>
                {card.phrase ? (
                  <div style={{ maxWidth: mobile ? "100%" : 760 }}>
                    <PhraseDisplay phrase={card.phrase} keywordStart={card.keywordStart} keywordEnd={card.keywordEnd} size="practice" />
                  </div>
                ) : (
                  <div style={{ fontFamily: font.display, fontSize: 24, fontWeight: 400, color: T.text, lineHeight: 1.4, maxWidth: mobile ? "100%" : 760 }}>
                    {card.word}
                  </div>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); speakPT(card.phrase || card.word); }}
                  style={{
                    marginTop: 24, background: T.accentSoft, border: `1px solid ${T.border}`,
                    borderRadius: 24, padding: "9px 22px", color: T.textSecondary,
                    fontFamily: font.body, fontSize: 13, cursor: "pointer",
                    display: "flex", alignItems: "center", gap: 8, transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.bgCardHover; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.accentSoft; }}
                >
                  <SpeakerIcon size={16} color={T.textSecondary} />
                  {t.listenPronunciation}
                </button>
              </>
            ) : (
              <div style={{ fontFamily: font.display, fontSize: 24, fontWeight: 400, color: T.text, lineHeight: 1.4, maxWidth: mobile ? "100%" : 760 }}>
                {card.translation}
              </div>
            )}
          </>
        )}
      </div>
      {flipped && (
        <div style={{ display: "flex", flexWrap: mobile ? "wrap" : "nowrap", gap: 8, marginTop: 16 }}>
          {qualityButtons.map((btn) => (
            <button
              key={btn.q}
              onClick={() => handleReview(btn.q)}
              style={{
                flex: mobile ? "1 1 28%" : 1,
                padding: mobile ? "10px 4px 8px" : "14px 6px 12px",
                background: T.bgCard,
                border: `1px solid ${T.border}`,
                borderRadius: T.radiusSm,
                cursor: "pointer",
                boxShadow: T.shadow,
                transition: "all 0.15s",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.transform = "translateY(-1px)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.transform = "translateY(0)"; }}
            >
              <span style={{ fontSize: 22 }}>{btn.emoji}</span>
              <span style={{ fontFamily: font.body, fontSize: 11, fontWeight: 500, color: T.textSecondary, lineHeight: 1.2, textAlign: "center" }}>
                {btn.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
// ─── Word Row ───
const WordRow = memo(function WordRow({ card, onDelete, onSpeak, onUpdate }) {
  const mobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const isOverdue = card.dueDate <= today();
  const daysUntil = Math.ceil((new Date(card.dueDate) - new Date(today())) / 86400000);
  const dueLabel = (() => {
    if (card.reps === 0 || (isOverdue && daysUntil < 0)) return t.newCard;
    if (daysUntil === 0) return t.today;
    const d = new Date(card.dueDate + "T12:00:00");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  })();
  const isNew = card.reps === 0 || (isOverdue && daysUntil < 0);
  const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const toEnHtml = () => escHtml(card.translation || "");
  const toPtHtml = () => {
    if (card.phrase && card.keywordStart !== undefined && card.keywordEnd !== undefined && card.keywordStart !== card.keywordEnd) {
      const before = card.phrase.slice(0, card.keywordStart);
      const kw = card.phrase.slice(card.keywordStart, card.keywordEnd);
      const after = card.phrase.slice(card.keywordEnd);
      return escHtml(before) + "<b>" + escHtml(kw) + "</b>" + escHtml(after);
    }
    return escHtml(card.word || "");
  };
  const parseHtmlBold = (html) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    let plain = "";
    let kwStart = null, kwEnd = null, kwText = "";
    const walk = (node) => {
      if (node.nodeType === 3) { plain += node.textContent; }
      else if (node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        const isBold = tag === "b" || tag === "strong" || (node.style && node.style.fontWeight && parseInt(node.style.fontWeight) >= 700);
        if (isBold && kwStart === null) kwStart = plain.length;
        for (const child of node.childNodes) walk(child);
        if (isBold && kwStart !== null && kwEnd === null) { kwEnd = plain.length; kwText = plain.slice(kwStart, kwEnd); }
      }
    };
    for (const child of tmp.childNodes) walk(child);
    return { plain, kwStart, kwEnd, kwText };
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
    const { plain, kwStart, kwEnd, kwText } = parseHtmlBold(html);
    const updated = { ...card };
    if (kwStart !== null && kwEnd !== null && kwText) {
      updated.phrase = plain;
      updated.word = kwText;
      updated.keywordStart = kwStart;
      updated.keywordEnd = kwEnd;
    } else {
      updated.word = plain;
      updated.phrase = "";
      updated.keywordStart = 0;
      updated.keywordEnd = 0;
    }
    if (updated.word !== card.word || updated.phrase !== card.phrase || updated.translation !== card.translation) {
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
    return (
      <div
        style={{
          padding: "12px 16px",
          borderBottom: `1px solid ${T.border}`,
          position: "relative",
          contentVisibility: "auto",
          containIntrinsicSize: "auto 80px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
          <span style={{ fontFamily: font.body, fontSize: 15, fontWeight: 700, color: T.keyword, wordBreak: "break-word" }}>{card.word}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {(() => {
              const stage = getStage(card);
              const sc = stageColors[stage];
              const isDark = T.bg === "#0E0E0E";
              return (
                <span style={{
                  fontFamily: font.mono, fontSize: 9, padding: "3px 8px", borderRadius: 20, letterSpacing: 0.5, whiteSpace: "nowrap",
                  background: sc.bg, color: isDark ? sc.darkText : sc.text,
                }}>
                  {stageLabel(stage)}
                </span>
              );
            })()}
            <div style={{ position: "relative" }}>
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                style={{
                  background: "none", border: "none", cursor: "pointer", padding: "4px 6px",
                  borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill={T.textSecondary}>
                  <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
                </svg>
              </button>
              {menuOpen && (
                <div style={{
                  position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 10,
                  background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radiusSm,
                  boxShadow: T.shadowLg, overflow: "hidden", minWidth: 150,
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
                    {t.delete}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ fontFamily: font.body, fontSize: 13, color: T.textSecondary, marginBottom: 4, wordBreak: "break-word" }}>
          {card.translation}
        </div>
        {card.phrase && (
          <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, wordBreak: "break-word" }}>
            <PhraseDisplay phrase={card.phrase} keywordStart={card.keywordStart} keywordEnd={card.keywordEnd} size="small" />
          </div>
        )}
        {!isNew && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
            <span style={{
              fontFamily: font.mono, fontSize: 9, padding: "3px 8px", borderRadius: 20, letterSpacing: 0.5, whiteSpace: "nowrap",
              background: isOverdue ? T.dangerBg : T.accentSoft,
              color: isOverdue ? T.danger : T.textTertiary,
            }}>
              {dueLabel}
            </span>
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 2fr 90px 90px 32px",
        gap: 12,
        alignItems: "start",
        padding: "10px 20px",
        borderBottom: `1px solid ${T.border}`,
        transition: "background 0.12s",
        contentVisibility: "auto",
        containIntrinsicSize: "auto 48px",
        position: "relative",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = T.bgCardHover)}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; setMenuOpen(false); }}
    >
      <span style={{ fontFamily: font.body, fontSize: 15, fontWeight: 700, color: T.keyword, padding: "6px 0", wordBreak: "break-word" }}>{card.word}</span>
      <EditableCell html={toEnHtml()} onCommit={commitEn} style={cellStyle} />
      <EditableCell html={toPtHtml()} onCommit={commitPt} style={cellStyle} />
      {(() => {
        const stage = getStage(card);
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
      {isNew ? (
        <div />
      ) : (
        <div style={{ display: "flex", justifyContent: "flex-start", paddingTop: 4 }}>
          <span style={{
            fontFamily: font.mono, fontSize: 10, padding: "4px 10px", borderRadius: 20, letterSpacing: 0.5, whiteSpace: "nowrap",
            background: isOverdue ? T.dangerBg : T.accentSoft,
            color: isOverdue ? T.danger : T.textTertiary,
          }}>
            {dueLabel}
          </span>
        </div>
      )}
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
            boxShadow: T.shadowLg, overflow: "hidden", minWidth: 150,
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
              excluir palavra
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
          position: "fixed", top: mobile ? 12 : 20, right: mobile ? 12 : 20, zIndex: 110,
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
      <div style={{ padding: mobile ? "20px 16px 60px" : "36px 32px 60px", maxWidth: 1100, margin: "0 auto" }}>
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
  const parseHtmlBold = (html) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    let plain = "";
    let kwStart = null;
    let kwEnd = null;
    let kwText = "";
    const walk = (node) => {
      if (node.nodeType === 3) {
        plain += node.textContent;
      } else if (node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        const isBold = tag === "b" || tag === "strong" || (node.style && node.style.fontWeight && parseInt(node.style.fontWeight) >= 700);
        if (isBold && kwStart === null) {
          kwStart = plain.length;
        }
        for (const child of node.childNodes) walk(child);
        if (isBold && kwStart !== null && kwEnd === null) {
          kwEnd = plain.length;
          kwText = plain.slice(kwStart, kwEnd);
        }
      }
    };
    for (const child of tmp.childNodes) walk(child);
    return { plain, kwStart, kwEnd, kwText };
  };
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
// ─── Chat / Conversar View ───
function ChatView({ dueCards, settings, onReviewCard, onGoToSettings }) {
  const apiKey = settings.apiKey || "";
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [wordsReviewed, setWordsReviewed] = useState(new Set());
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);
  const dueWordList = dueCards.map((c) => `${c.word} (${c.translation})`).join(", ");
  const systemPrompt = `You are a warm and encouraging Portuguese (Brazilian) conversation partner. The learner has these vocabulary words due for review: ${dueWordList}.
Your role:
1. Create NEW example sentences (different from their flashcard phrases) naturally weaving in the due vocabulary words
2. Hold a natural, engaging conversation in Portuguese — keep it casual and Paulistano in style
3. When the learner correctly uses one of the due vocabulary words in their reply, acknowledge it naturally (e.g., "Isso! Você usou 'aconchegante' muito bem!")
4. Gently correct errors without dwelling on them
5. Keep your responses concise (2–4 sentences) — this is a chat, not a lecture
6. When you detect a due vocabulary word used correctly by the learner, end your message with a JSON marker on its own line: WORD_USED:{"word":"palavra"} — this is parsed programmatically, keep it exact
Start the conversation naturally in Portuguese, using one or two of the due words in a new context. Make it feel like a genuine conversation, not a language drill.`;
  const sendToAPI = async (currentMessages, isFirst = false) => {
    setLoading(true);
    const contents = isFirst
      ? [{ role: "user", parts: [{ text: "Oi! Estou pronto para praticar." }] }]
      : currentMessages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: { maxOutputTokens: 600, temperature: 0.9 },
          }),
        }
      );
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `API error ${response.status}`);
      }
      const data = await response.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const wordUsedMatch = rawText.match(/\nWORD_USED:\{"word":"(.+?)"\}/);
      const wordUsed = wordUsedMatch ? wordUsedMatch[1] : null;
      const cleanText = rawText.replace(/\nWORD_USED:\{.*?\}/g, "").trim();
      const assistantMsg = { role: "assistant", content: cleanText };
      const newMessages = isFirst
        ? [assistantMsg]
        : [...currentMessages, assistantMsg];
      setMessages(newMessages);
      if (wordUsed) {
        const card = dueCards.find((c) => c.word.toLowerCase() === wordUsed.toLowerCase());
        if (card && !wordsReviewed.has(card.id)) {
          setWordsReviewed((prev) => new Set([...prev, card.id]));
          onReviewCard(card.id, 3);
        }
      }
    } catch (err) {
      const errMsg = { role: "assistant", content: `⚠️ Erro: ${err.message}`, isError: true };
      setMessages((prev) => [...prev, errMsg]);
    }
    setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  };
  if (!apiKey) {
    return (
      <div style={{ textAlign: "center", padding: "80px 20px" }}>
        <div style={{ width: 48, height: 48, borderRadius: 24, background: T.accentSoft, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={T.textSecondary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
        <div style={{ fontFamily: font.display, fontSize: 22, fontWeight: 700, color: T.text, marginBottom: 8 }}>{t.chatNoKey}</div>
        <div style={{ fontFamily: font.body, fontSize: 14, color: T.textTertiary, marginBottom: 28, lineHeight: 1.6, maxWidth: 340, margin: "0 auto 28px" }}>{t.chatNoKeyDesc}</div>
        <button onClick={onGoToSettings} style={{ padding: "11px 28px", background: T.accent, border: "none", borderRadius: T.radiusSm, color: T.bg, fontFamily: font.body, fontSize: 14, fontWeight: 600, cursor: "pointer", letterSpacing: 0.3 }}>
          {t.chatGoToSettings}
        </button>
      </div>
    );
  }
  if (dueCards.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "80px 20px" }}>
        <div style={{ width: 48, height: 48, borderRadius: 24, background: T.accentSoft, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={T.textSecondary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div style={{ fontFamily: font.display, fontSize: 22, fontWeight: 700, color: T.text, marginBottom: 8, textTransform: "capitalize" }}>{t.chatNoDue}</div>
        <div style={{ fontFamily: font.body, fontSize: 14, color: T.textTertiary, lineHeight: 1.6 }}>{t.chatNoDueDesc}</div>
      </div>
    );
  }
  if (!started) {
    return (
      <div style={{ textAlign: "center", padding: "80px 20px" }}>
        <div style={{ width: 48, height: 48, borderRadius: 24, background: T.keywordBg, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={T.keyword} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </div>
        <div style={{ fontFamily: font.display, fontSize: 22, fontWeight: 700, color: T.text, marginBottom: 8, textTransform: "capitalize" }}>{t.chatReady}</div>
        <div style={{ fontFamily: font.body, fontSize: 14, color: T.textTertiary, marginBottom: 8, lineHeight: 1.6, maxWidth: 360, margin: "0 auto 8px" }}>{t.chatReadyDesc}</div>
        <div style={{ fontFamily: font.mono, fontSize: 11, color: T.textTertiary, marginBottom: 32 }}>
          {dueCards.length} {dueCards.length === 1 ? t.word : t.wordsPlural} · {t.chatWordsUsed}: 0
        </div>
        <button
          onClick={async () => {
            setStarted(true);
            await sendToAPI([], true);
          }}
          style={{ padding: "13px 36px", background: T.accent, border: "none", borderRadius: T.radiusSm, color: T.bg, fontFamily: font.body, fontSize: 14, fontWeight: 600, cursor: "pointer", letterSpacing: 0.3, transition: "all 0.15s" }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.85"; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
        >
          {t.chatStart}
        </button>
      </div>
    );
  }
  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const userMsg = { role: "user", content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    await sendToAPI(newMessages);
  };
  const handleReset = () => {
    setMessages([]);
    setStarted(false);
    setWordsReviewed(new Set());
    setInput("");
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 180px)", minHeight: 500 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ fontFamily: font.mono, fontSize: 11, color: T.textTertiary, textTransform: "uppercase", letterSpacing: 1.5 }}>
          {t.chatSessionTitle}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {wordsReviewed.size > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: T.keywordBg, borderRadius: 20, padding: "4px 12px" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={T.keyword} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span style={{ fontFamily: font.mono, fontSize: 11, color: T.keyword, fontWeight: 600 }}>
                {wordsReviewed.size} {wordsReviewed.size === 1 ? t.chatWordUsed : t.chatWordsUsed}
              </span>
            </div>
          )}
          <button
            onClick={handleReset}
            style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: T.radiusSm, padding: "6px 14px", color: T.textTertiary, fontFamily: font.body, fontSize: 12, cursor: "pointer", transition: "all 0.15s" }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.color = T.text; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textTertiary; }}
          >
            {t.chatNewSession}
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingBottom: 8 }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "78%",
              padding: "12px 16px",
              borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
              background: msg.role === "user" ? T.accent : T.bgCard,
              border: msg.role === "user" ? "none" : `1px solid ${T.border}`,
              color: msg.role === "user" ? T.bg : (msg.isError ? T.danger : T.text),
              fontFamily: font.body,
              fontSize: 14,
              lineHeight: 1.65,
              boxShadow: T.shadow,
            }}>
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={{ padding: "12px 18px", borderRadius: "16px 16px 16px 4px", background: T.bgCard, border: `1px solid ${T.border}`, fontFamily: font.body, fontSize: 13, color: T.textTertiary, fontStyle: "italic", boxShadow: T.shadow }}>
              {t.chatThinking}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder={t.chatInputPlaceholder}
          disabled={loading}
          style={{
            flex: 1,
            padding: "13px 16px",
            background: T.bgInput,
            border: `1px solid transparent`,
            borderRadius: T.radiusSm,
            color: T.text,
            fontFamily: font.body,
            fontSize: 14,
            outline: "none",
            transition: "border-color 0.2s",
            opacity: loading ? 0.6 : 1,
          }}
          onFocus={(e) => { e.target.style.borderColor = T.borderStrong; }}
          onBlur={(e) => { e.target.style.borderColor = "transparent"; }}
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          style={{
            padding: "13px 22px",
            background: !loading && input.trim() ? T.accent : T.bgInput,
            border: "none",
            borderRadius: T.radiusSm,
            color: !loading && input.trim() ? T.bg : T.textPlaceholder,
            fontFamily: font.body,
            fontSize: 14,
            fontWeight: 600,
            cursor: !loading && input.trim() ? "pointer" : "default",
            transition: "all 0.2s",
            letterSpacing: 0.3,
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { if (!loading && input.trim()) e.currentTarget.style.opacity = "0.85"; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
        >
          {t.chatSend}
        </button>
      </div>
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
    await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        action: "writeMeta",
        practiceDays: JSON.stringify(practiceDays),
        deletedCards: JSON.stringify(deletedCards || {}),
      }),
    }).catch(() => {});
  },
};
// ─── Merge Logic ───
const mergeCards = (localCards, remoteCards, localDeleted, remoteDeleted) => {
  const merged = {};
  const mergedDeleted = {};
  // Combine deletions, keep newer timestamp per ID
  for (const [id, t] of Object.entries(localDeleted || {})) mergedDeleted[id] = Math.max(mergedDeleted[id] || 0, t);
  for (const [id, t] of Object.entries(remoteDeleted || {})) mergedDeleted[id] = Math.max(mergedDeleted[id] || 0, t);
  // Index all cards by ID, keep newer version
  for (const c of localCards) merged[c.id] = c;
  for (const c of remoteCards) {
    if (!merged[c.id] || (c.modifiedAt || 0) > (merged[c.id].modifiedAt || 0)) {
      merged[c.id] = c;
    }
  }
  // Apply deletions: delete if tombstone is newer than card
  for (const [id, delTime] of Object.entries(mergedDeleted)) {
    if (merged[id] && (merged[id].modifiedAt || 0) <= delTime) {
      delete merged[id];
    } else if (merged[id]) {
      // Card modified after deletion — keep card, remove tombstone
      delete mergedDeleted[id];
    }
  }
  // Prune tombstones older than 30 days
  const cutoff = Date.now() - 30 * 86400000;
  for (const [id, delTime] of Object.entries(mergedDeleted)) {
    if (delTime < cutoff) delete mergedDeleted[id];
  }
  return { cards: Object.values(merged), deleted: mergedDeleted };
};
const mergePracticeDays = (local, remote) => {
  const merged = { ...local };
  for (const [day, count] of Object.entries(remote || {})) {
    merged[day] = Math.max(merged[day] || 0, count);
  }
  return merged;
};
// ─── Main App ───
export default function VocabApp() {
  const mobile = useIsMobile();
  const [cards, setCards] = useState([]);
  const [practiceDays, setPracticeDays] = useState({});
  const [view, setView] = useState("practice");
  const [loaded, setLoaded] = useState(false);
  const [heatmapYear, setHeatmapYear] = useState(new Date().getFullYear());
  const [showAddInline, setShowAddInline] = useState(false);
  const [showImportInline, setShowImportInline] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [deletedCards, setDeletedCards] = useState({});
  const [sortKey, setSortKey] = useState("dueDate");
  const [sortDir, setSortDir] = useState("asc");
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
  const [settings, setSettings] = useState({
    theme: "light",
    dailyGoal: 20,
    cardOrder: "due",
    lang: "pt-BR",
    apiKey: "",
    scriptUrl: "",
  });
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [scriptUrlInput, setScriptUrlInput] = useState("");
  const [syncStatus, setSyncStatus] = useState("idle");
  const [syncError, setSyncError] = useState("");
  const [lastSynced, setLastSynced] = useState(null);
  const [sheetsSaved, setSheetsSaved] = useState(false);
  const dirtyRef = useRef(false);
  const syncTimerRef = useRef(null);
  const cardsRef = useRef(cards);
  const practiceDaysRef = useRef(practiceDays);
  const deletedCardsRef = useRef(deletedCards);
  useEffect(() => { cardsRef.current = cards; }, [cards]);
  useEffect(() => { practiceDaysRef.current = practiceDays; }, [practiceDays]);
  useEffect(() => { deletedCardsRef.current = deletedCards; }, [deletedCards]);
  T = themes[settings.theme] || themes.light;
  t = i18n[settings.lang] || i18n["pt-BR"];
  const doSync = useCallback(async (localCards, localDays, scriptUrl) => {
    if (!scriptUrl) return;
    setSyncStatus("syncing");
    try {
      // Read remote state
      const remoteCards = await GSheets.readCards(scriptUrl);
      const remoteMeta = await GSheets.readMeta(scriptUrl);
      // Merge
      const { cards: mergedCards, deleted: mergedDeleted } = mergeCards(
        localCards, remoteCards,
        deletedCardsRef.current, remoteMeta.deletedCards || {}
      );
      const mergedDays = mergePracticeDays(localDays, remoteMeta.practiceDays || {});
      // Write merged result
      await GSheets.writeCards(scriptUrl, mergedCards);
      await GSheets.writeMeta(scriptUrl, mergedDays, mergedDeleted);
      // Update local state
      setCards(mergedCards);
      setPracticeDays(mergedDays);
      setDeletedCards(mergedDeleted);
      await window.storage.set("vocab-cards", JSON.stringify(mergedCards)).catch(() => {});
      await window.storage.set("vocab-practice-days", JSON.stringify(mergedDays)).catch(() => {});
      await window.storage.set("vocab-deleted", JSON.stringify(mergedDeleted)).catch(() => {});
      setSyncStatus("synced");
      setLastSynced(new Date().toLocaleTimeString());
      setSyncError("");
    } catch (e) {
      setSyncStatus("error");
      setSyncError(e.message);
    }
  }, []);
  const scheduleSyncIfDirty = useCallback(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      if (dirtyRef.current && settings.scriptUrl) {
        doSync(cardsRef.current, practiceDaysRef.current, settings.scriptUrl);
        dirtyRef.current = false;
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
          setSettings((prev) => ({ ...prev, ...savedSettings }));
          if (savedSettings.apiKey) setApiKeyInput(savedSettings.apiKey);
          if (savedSettings.scriptUrl) setScriptUrlInput(savedSettings.scriptUrl);
        }
      } catch {}
      // Load local data
      let localCards = [];
      let localDays = {};
      let localDeleted = {};
      try { const r = await window.storage.get("vocab-cards"); if (r) localCards = JSON.parse(r.value); } catch {}
      try { const r = await window.storage.get("vocab-practice-days"); if (r) localDays = JSON.parse(r.value); } catch {}
      try { const r = await window.storage.get("vocab-deleted"); if (r) localDeleted = JSON.parse(r.value); } catch {}
      // One-time RemNote due date + last practiced migration
      let didRemnoteMigration = false;
      let remnotePracticeDays = {};
      try {
        const migFlag = await window.storage.get("vocab-remnote-migrated-v3");
        if (!migFlag) {
          const migResult = applyRemnoteDueDates(localCards);
          localCards = migResult.cards;
          remnotePracticeDays = migResult.practiceDayCounts;
          // Merge RemNote practice days into local days
          for (const [day, count] of Object.entries(remnotePracticeDays)) {
            localDays[day] = Math.max(localDays[day] || 0, count);
          }
          didRemnoteMigration = true;
          await window.storage.set("vocab-remnote-migrated-v3", "1").catch(() => {});
          await window.storage.set("vocab-cards", JSON.stringify(localCards)).catch(() => {});
          await window.storage.set("vocab-practice-days", JSON.stringify(localDays)).catch(() => {});
        }
      } catch {}
      // Show local data immediately
      setCards(localCards);
      setPracticeDays(localDays);
      setDeletedCards(localDeleted);
      setLoaded(true);

      // Background sync with Google Sheets
      const sUrl = savedSettings?.scriptUrl || "";
      if (sUrl) {
        setSyncStatus("syncing");
        try {
          const remoteCards = await GSheets.readCards(sUrl);
          const remoteMeta = await GSheets.readMeta(sUrl);
          const { cards: merged, deleted: mergedDel } = mergeCards(
            localCards, remoteCards, localDeleted, remoteMeta.deletedCards || {}
          );
          let mergedDays = mergePracticeDays(localDays, remoteMeta.practiceDays || {});
          let finalCards = merged;
          if (didRemnoteMigration) {
            const migResult = applyRemnoteDueDates(merged);
            finalCards = migResult.cards;
            for (const [day, count] of Object.entries(migResult.practiceDayCounts)) {
              mergedDays[day] = Math.max(mergedDays[day] || 0, count);
            }
          }
          setCards(finalCards);
          setPracticeDays(mergedDays);
          setDeletedCards(mergedDel);
          await window.storage.set("vocab-cards", JSON.stringify(finalCards)).catch(() => {});
          await window.storage.set("vocab-practice-days", JSON.stringify(mergedDays)).catch(() => {});
          await window.storage.set("vocab-deleted", JSON.stringify(mergedDel)).catch(() => {});
          await GSheets.writeCards(sUrl, finalCards);
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
        doSync(cardsRef.current, practiceDaysRef.current, settings.scriptUrl);
        dirtyRef.current = false;
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
    setSyncStatus("syncing");
    try {
      const remoteCards = await GSheets.readCards(settings.scriptUrl);
      const remoteMeta = await GSheets.readMeta(settings.scriptUrl);
      const { cards: merged, deleted: mergedDel } = mergeCards(
        cards, remoteCards, deletedCards, remoteMeta.deletedCards || {}
      );
      const mergedDays = mergePracticeDays(practiceDays, remoteMeta.practiceDays || {});
      await GSheets.writeCards(settings.scriptUrl, merged);
      await GSheets.writeMeta(settings.scriptUrl, mergedDays, mergedDel);
      setCards(merged);
      setPracticeDays(mergedDays);
      setDeletedCards(mergedDel);
      await window.storage.set("vocab-cards", JSON.stringify(merged)).catch(() => {});
      await window.storage.set("vocab-practice-days", JSON.stringify(mergedDays)).catch(() => {});
      await window.storage.set("vocab-deleted", JSON.stringify(mergedDel)).catch(() => {});
      dirtyRef.current = false;
      setSyncStatus("synced");
      setLastSynced(new Date().toLocaleTimeString());
      setSyncError("");
    } catch (e) {
      setSyncStatus("error");
      setSyncError(e.message);
    }
  }, [cards, practiceDays, deletedCards, settings.scriptUrl]);
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
  const saveSettings = useCallback(async (newSettings) => {
    setSettings(newSettings);
    try { await window.storage.set("vocab-settings", JSON.stringify(newSettings)); } catch (e) { console.error("Settings save failed:", e); }
  }, []);
  const addCard = (card) => { const nc = [...cards, card]; setCards(nc); save(nc, practiceDays); setShowAddInline(false); };
  const addCards = (newCards) => { const nc = [...cards, ...newCards]; setCards(nc); save(nc, practiceDays); };
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
  const reviewCard = (id, quality) => {
    const nc = cards.map((c) => c.id === id ? FSRS.review(c, quality) : c);
    const nd = { ...practiceDays }; const t = today(); nd[t] = (nd[t] || 0) + 1;
    setCards(nc); setPracticeDays(nd); save(nc, nd);
  };
  const [skippedIds, setSkippedIds] = useState(new Set());
  const skipCard = (id) => { setSkippedIds((prev) => new Set([...prev, id])); };
  const dueCards = useMemo(() => {
    let due = cards.filter((c) => c.dueDate <= today() && !skippedIds.has(c.id));
    if (settings.cardOrder === "random") {
      const seed = today().replace(/-/g, "") | 0;
      const shuffled = [...due];
      let m = shuffled.length, t, i, s = seed;
      while (m) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        i = s % m--;
        t = shuffled[m]; shuffled[m] = shuffled[i]; shuffled[i] = t;
      }
      return shuffled;
    }
    return due.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }, [cards, skippedIds, settings.cardOrder]);
  const sortedCards = useMemo(() => {
    const so = { new: 0, learning: 1, young: 2, mature: 3, mastered: 4 };
    return [...cards].sort((a, b) => {
      let va, vb;
      if (sortKey === "word") { va = (a.word || "").toLowerCase(); vb = (b.word || "").toLowerCase(); }
      else if (sortKey === "translation") { va = (a.translation || "").toLowerCase(); vb = (b.translation || "").toLowerCase(); }
      else if (sortKey === "phrase") { va = (a.phrase || "").toLowerCase(); vb = (b.phrase || "").toLowerCase(); }
      else if (sortKey === "stage") { va = so[getStage(a)]; vb = so[getStage(b)]; }
      else if (sortKey === "dueDate") { va = a.dueDate || ""; vb = b.dueDate || ""; }
      else { va = ""; vb = ""; }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
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
  const dueReview = useMemo(() => dueCards.filter(c => c.reps > 0).length, [dueCards]);
  const dueNew = useMemo(() => dueCards.filter(c => c.reps === 0).length, [dueCards]);
  if (!loaded) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontFamily: font.display, fontSize: 16, fontWeight: 700, color: T.textTertiary }}>carregando...</span>
      </div>
    );
  }
  const practiceBadge = (dueReview || dueNew) ? `${dueReview > 0 ? "D" + dueReview : ""}${dueReview > 0 && dueNew > 0 ? " | " : ""}${dueNew > 0 ? "N" + dueNew : ""}` : null;
  const practiceBadgeMobile = dueReview > 0 ? `D${dueReview}` : null;
  const navItems = [
    { id: "practice", label: t.practice, badge: practiceBadge },
    { id: "words", label: t.words, badge: cards.length || null },
    { id: "chat", label: t.chat, badge: null },
    { id: "heatmap", label: t.progress },
  ];
  const todayFormatted = new Date().toLocaleDateString(settings.lang === "en" ? "en-US" : "pt-BR", { weekday: "long", day: "numeric", month: "long" });
  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text }}>
      <style>{`
        * { -webkit-font-smoothing: antialiased; box-sizing: border-box; }
        ::placeholder { color: ${T.textPlaceholder}; }
        textarea::placeholder { color: ${T.textPlaceholder}; }
        button:active { transform: scale(0.98); }
        [contenteditable] b, [contenteditable] strong { color: ${T.keyword}; font-weight: 700; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .nav-scroll::-webkit-scrollbar { display: none; }
        .nav-scroll { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
      <div style={{ padding: mobile ? "20px 16px 0" : "36px 32px 0", maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 style={{ fontFamily: font.display, fontSize: 28, fontWeight: 700, color: T.text, margin: 0, letterSpacing: -0.5, textTransform: "capitalize" }}>
            vocabulário
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={() => settings.scriptUrl ? manualSync() : setShowSettingsModal(true)}
            disabled={syncStatus === "syncing"}
            title={syncStatus === "synced" && lastSynced ? `${t.sheetsLastSync} ${lastSynced}` : syncStatus === "error" ? syncError : !settings.scriptUrl ? "Configure Google Sheets sync in settings" : ""}
            style={{
              display: "flex", alignItems: "center", gap: 7,
              padding: "6px 12px", borderRadius: 9999,
              background: syncStatus === "synced" ? T.keywordBg : syncStatus === "error" ? T.dangerBg : T.accentSoft,
              border: `1px solid ${syncStatus === "synced" ? "rgba(45,106,79,0.2)" : syncStatus === "error" ? "rgba(196,72,62,0.2)" : T.border}`,
              cursor: syncStatus === "syncing" ? "default" : "pointer",
              transition: "all 0.2s",
            }}
            onMouseEnter={(e) => { if (syncStatus !== "syncing") e.currentTarget.style.opacity = "0.8"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
          >
            {syncStatus === "syncing" ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={T.textTertiary} strokeWidth="2.5" strokeLinecap="round" style={{ animation: "spin 1s linear infinite" }}>
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
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={T.textTertiary} strokeWidth="2.5" strokeLinecap="round">
                <path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
                <path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
              </svg>
            )}
            <span style={{ fontFamily: font.mono, fontSize: 10, letterSpacing: 0.3, color: syncStatus === "synced" ? T.success : syncStatus === "error" ? T.danger : T.textTertiary }}>
              {syncStatus === "syncing" ? t.sheetsSyncing : syncStatus === "synced" ? (lastSynced || t.sheetsSynced) : syncStatus === "error" ? t.sheetsError : "sync"}
            </span>
          </button>
          <button
            onClick={() => setShowSettingsModal(true)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 34, height: 34, borderRadius: 9999,
              background: T.accentSoft,
              border: `1px solid ${T.border}`,
              cursor: "pointer", transition: "all 0.2s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={T.textTertiary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          </div>
        </div>
        <div className="nav-scroll" style={{ display: mobile ? "none" : "flex", gap: 0, borderBottom: `1px solid ${T.border}`, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              style={{
                padding: mobile ? "10px 14px" : "12px 20px",
                background: "none",
                border: "none",
                borderBottom: view === item.id ? `2px solid ${T.accent}` : "2px solid transparent",
                color: view === item.id ? T.text : T.textTertiary,
                fontFamily: font.body,
                fontSize: mobile ? 13 : 14,
                fontWeight: 500,
                cursor: "pointer",
                transition: "color 0.15s, border-color 0.15s",
                display: "flex",
                alignItems: "center",
                gap: 6,
                letterSpacing: 0.2,
                textTransform: "capitalize",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
              onMouseEnter={(e) => { if (view !== item.id) e.currentTarget.style.color = T.textSecondary; }}
              onMouseLeave={(e) => { if (view !== item.id) e.currentTarget.style.color = T.textTertiary; }}
            >
              {item.label}
              {item.badge && (
                <span style={{
                  background: view === item.id ? T.accent : T.accentSoft,
                  color: view === item.id ? T.bg : T.textTertiary,
                  fontFamily: font.mono, fontSize: 10, fontWeight: 500,
                  padding: "2px 7px", borderRadius: 9999,
                }}>
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: mobile ? "20px 16px 100px" : "32px 32px 60px", maxWidth: 1100, margin: "0 auto" }}>
        {view === "practice" && (
          <>
            {dueCards.length === 0 ? (
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
              <>
                <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
                  <div style={{ display: "inline-flex", background: T.bgInput, borderRadius: 9999, padding: 3 }}>
                    {[
                      { id: "en-pt", label: t.enToPt },
                      { id: "pt-en", label: t.ptToEn },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => setStudyDirection(opt.id)}
                        style={{
                          padding: "6px 16px",
                          background: studyDirection === opt.id ? T.bgCard : "transparent",
                          border: "none",
                          borderRadius: 9999,
                          fontFamily: font.mono,
                          fontSize: 12,
                          fontWeight: studyDirection === opt.id ? 600 : 400,
                          color: studyDirection === opt.id ? T.text : T.textTertiary,
                          cursor: "pointer",
                          transition: "all 0.15s",
                          boxShadow: studyDirection === opt.id ? T.shadow : "none",
                          letterSpacing: 0.5,
                        }}
                        onMouseEnter={(e) => { if (studyDirection !== opt.id) e.currentTarget.style.background = T.bgCardHover; }}
                        onMouseLeave={(e) => { if (studyDirection !== opt.id) e.currentTarget.style.background = "transparent"; }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <PracticeCard key={dueCards[0].id} card={dueCards[0]} onReview={reviewCard} onSkip={skipCard} totalDue={dueCards.length} studyDirection={studyDirection} />
              </>
            )}
          </>
        )}
        {view === "chat" && (
          <ChatView
            dueCards={dueCards}
            settings={settings}
            onReviewCard={reviewCard}
            onGoToSettings={() => setShowSettingsModal(true)}
          />
        )}
        {view === "words" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <div style={{ position: "relative", width: mobile ? undefined : "60%", flex: mobile ? 1 : undefined }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={T.textPlaceholder} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t.searchPlaceholder || "buscar..."}
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
              <button
                onClick={() => { setGroupByStage(prev => !prev); setCollapsedGroups(new Set()); }}
                style={{
                  padding: "9px 14px",
                  marginLeft: mobile ? 0 : "auto",
                  background: groupByStage ? T.accent : "transparent",
                  border: `1px solid ${groupByStage ? T.accent : T.border}`,
                  borderRadius: T.radiusSm,
                  color: groupByStage ? T.bg : T.textSecondary,
                  fontFamily: font.body, fontSize: 13, fontWeight: 500, cursor: "pointer", letterSpacing: 0.2,
                  display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
                  transition: "all 0.15s",
                }}
                onMouseEnter={(e) => { if (!groupByStage) { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.accentSoft; } }}
                onMouseLeave={(e) => { if (!groupByStage) { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; } }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
                </svg>
                {t.groupByStage}
              </button>
              <button
                onClick={() => setShowImportInline(true)}
                style={{
                  padding: "9px 18px", background: T.accent,
                  border: "none",
                  borderRadius: T.radiusSm,
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
              <div style={{ borderRadius: T.radius, border: `1px solid ${T.border}`, background: T.bgCard, boxShadow: mobile ? "none" : T.shadow }}>
                <div style={{ display: mobile ? "none" : "grid", gridTemplateColumns: "1fr 1fr 2fr 90px 90px 32px", gap: 12, padding: "11px 20px", borderBottom: `1px solid ${T.border}` }}>
                  {[
                    { key: "word", label: t.headerPalavra },
                    { key: "translation", label: t.headerEnglish },
                    { key: "phrase", label: t.headerPortuguese },
                    { key: "stage", label: t.headerStage },
                    { key: "dueDate", label: t.headerDue },
                    { key: null, label: "" },
                  ].map((col, ci) => (
                    <span
                      key={ci}
                      onClick={() => {
                        if (!col.key) return;
                        setSortKey((prev) => prev === col.key ? col.key : col.key);
                        setSortDir((prev) => sortKey === col.key ? (prev === "asc" ? "desc" : "asc") : "asc");
                      }}
                      style={{
                        fontFamily: font.mono, fontSize: 9, color: sortKey === col.key ? T.text : T.textTertiary,
                        textTransform: "uppercase", letterSpacing: 2,
                        cursor: col.key ? "pointer" : "default",
                        userSelect: "none",
                        display: "flex", alignItems: "center", gap: 4,
                        transition: "color 0.15s",
                      }}
                      onMouseEnter={(e) => { if (col.key) e.currentTarget.style.color = T.text; }}
                      onMouseLeave={(e) => { if (col.key) e.currentTarget.style.color = sortKey === col.key ? T.text : T.textTertiary; }}
                    >
                      {col.label}
                      {col.key && sortKey === col.key && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={T.text} strokeWidth="2.5" strokeLinecap="round">
                          {sortDir === "asc"
                            ? <polyline points="18 15 12 9 6 15"/>
                            : <polyline points="6 9 12 15 18 9"/>
                          }
                        </svg>
                      )}
                    </span>
                  ))}
                </div>
                {groupByStage ? (
                  ["new", "learning", "young", "mature", "mastered"].map(stage => {
                    const stageCards = filteredCards.filter(c => getStage(c) === stage);
                    if (stageCards.length === 0) return null;
                    const sc = stageColors[stage];
                    const isDark = T.bg === "#0E0E0E";
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
                          <WordRow key={card.id} card={card} onDelete={deleteCard} onSpeak={speakPT} onUpdate={updateCard} />
                        ))}
                      </div>
                    );
                  })
                ) : (
                  filteredCards.map((card) => <WordRow key={card.id} card={card} onDelete={deleteCard} onSpeak={speakPT} onUpdate={updateCard} />)
                )}
              </div>
            )}
          </>
        )}
        {view === "heatmap" && (
          <Suspense fallback={<div style={{ padding: 40, textAlign: "center", color: T.textTertiary }}>...</div>}>
          <RechartsModule>
          {({ PieChart, Pie, Label, Tooltip: RechartsTooltip, Cell, AreaChart, Area, XAxis, CartesianGrid, ResponsiveContainer }) => (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: mobile ? 8 : 14, marginBottom: 14 }}>
              {[
                { label: t.daysStudied, value: (() => {
                  const yr = new Date().getFullYear();
                  return Object.keys(practiceDays).filter((d) => d.startsWith(String(yr)) && practiceDays[d] > 0).length;
                })() },
                { label: t.dayStreak, value: (() => {
                  let streak = 0;
                  let d = new Date();
                  while (true) {
                    const ds = d.toISOString().split("T")[0];
                    if (practiceDays[ds] && practiceDays[ds] > 0) { streak++; d.setDate(d.getDate() - 1); } else break;
                  }
                  return streak;
                })() },
                { label: t.avgPerDay, value: (() => {
                  const ad = Object.values(practiceDays).filter((v) => v > 0).length;
                  if (!ad) return 0;
                  return (Object.values(practiceDays).reduce((a, b) => a + b, 0) / ad).toFixed(1);
                })() },
              ].map((stat, i) => (
                <div key={i} style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: mobile ? "14px 8px" : "22px 16px", textAlign: "center", boxShadow: T.shadow }}>
                  <div style={{ fontFamily: font.display, fontSize: mobile ? 22 : 32, fontWeight: 700, color: T.text }}>{stat.value}</div>
                  <div style={{ fontFamily: font.mono, fontSize: mobile ? 8 : 9, color: T.textTertiary, textTransform: "uppercase", letterSpacing: mobile ? 1 : 1.8, marginTop: 4 }}>{stat.label}</div>
                </div>
              ))}
            </div>
            <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: mobile ? 12 : 28, boxShadow: T.shadow, overflowX: "auto", marginBottom: 14 }}>
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
              return (
                <div style={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: T.radius, padding: mobile ? 16 : 28, boxShadow: T.shadow, marginBottom: 14 }}>
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
                const ds = d.toISOString().split("T")[0];
                chartData.push({
                  date: ds,
                  reviews: practiceDays[ds] || 0,
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
                    <div style={{ position: "relative" }}>
                      <select
                        value={activityRange}
                        onChange={(e) => setActivityRange(e.target.value)}
                        style={{
                          appearance: "none",
                          padding: "8px 32px 8px 14px",
                          background: T.bgInput,
                          border: `1px solid ${T.border}`,
                          borderRadius: T.radiusSm,
                          color: T.text,
                          fontFamily: font.body,
                          fontSize: 13,
                          cursor: "pointer",
                          outline: "none",
                        }}
                      >
                        <option value="week">{t.thisWeek}</option>
                        <option value="month">{t.thisMonth}</option>
                        <option value="year">{t.thisYear}</option>
                      </select>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={T.textTertiary} strokeWidth="2" strokeLinecap="round"
                        style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
                        <polyline points="6 9 12 15 18 9"/>
                      </svg>
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
                      { id: "pt-BR", label: "Português (Brasil)", icon: "🇧🇷" },
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
                      { id: "random", label: t.cardOrderRandom, desc: t.cardOrderRandomDesc },
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
                  <div style={{ fontFamily: font.body, fontSize: 13, color: T.textTertiary, marginBottom: 12, lineHeight: 1.5 }}>
                    {t.sheetsSyncDesc}
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
                            setSyncStatus("syncing");
                            try {
                              const sUrl = scriptUrlInput.trim();
                              const remoteCards = await GSheets.readCards(sUrl);
                              const remoteMeta = await GSheets.readMeta(sUrl);
                              const { cards: merged, deleted: mergedDel } = mergeCards(
                                cards, remoteCards, deletedCards, remoteMeta.deletedCards || {}
                              );
                              const mergedDays = mergePracticeDays(practiceDays, remoteMeta.practiceDays || {});
                              await GSheets.writeCards(sUrl, merged);
                              await GSheets.writeMeta(sUrl, mergedDays, mergedDel);
                              setCards(merged);
                              setPracticeDays(mergedDays);
                              setDeletedCards(mergedDel);
                              await window.storage.set("vocab-cards", JSON.stringify(merged)).catch(() => {});
                              await window.storage.set("vocab-practice-days", JSON.stringify(mergedDays)).catch(() => {});
                              await window.storage.set("vocab-deleted", JSON.stringify(mergedDel)).catch(() => {});
                              setSyncStatus("synced");
                              setLastSynced(new Date().toLocaleTimeString());
                              setSyncError("");
                            } catch(e) {
                              setSyncStatus("error");
                              setSyncError(e.message);
                            }
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
                          onClick={async () => {
                            setSyncStatus("syncing");
                            try {
                              const remoteCards = await GSheets.readCards(settings.scriptUrl);
                              const remoteMeta = await GSheets.readMeta(settings.scriptUrl);
                              const { cards: merged, deleted: mergedDel } = mergeCards(
                                cards, remoteCards, deletedCards, remoteMeta.deletedCards || {}
                              );
                              const mergedDays = mergePracticeDays(practiceDays, remoteMeta.practiceDays || {});
                              setCards(merged);
                              setPracticeDays(mergedDays);
                              setDeletedCards(mergedDel);
                              await window.storage.set("vocab-cards", JSON.stringify(merged)).catch(() => {});
                              await window.storage.set("vocab-practice-days", JSON.stringify(mergedDays)).catch(() => {});
                              await window.storage.set("vocab-deleted", JSON.stringify(mergedDel)).catch(() => {});
                              setSyncStatus("synced");
                              setLastSynced(new Date().toLocaleTimeString());
                            } catch(e) { setSyncStatus("error"); setSyncError(e.message); }
                          }}
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
          position: "fixed", bottom: 12, left: 12, right: 12,
          background: settings.theme === "dark" ? "rgba(30,30,30,0.65)" : "rgba(255,255,255,0.55)",
          borderRadius: 9999,
          border: `1px solid ${settings.theme === "dark" ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.6)"}`,
          boxShadow: `0 8px 32px rgba(0,0,0,${settings.theme === "dark" ? "0.4" : "0.12"}), inset 0 1px 0 ${settings.theme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.7)"}`,
          backdropFilter: "blur(24px) saturate(1.8)",
          WebkitBackdropFilter: "blur(24px) saturate(1.8)",
          display: "flex", justifyContent: "space-around", alignItems: "center",
          padding: "4px 4px",
          zIndex: 1000,
        }}>
          {[
            { id: "practice", label: t.practice, badge: practiceBadgeMobile, icon: (active) => (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? T.text : T.textTertiary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12H17V17C17 19.7614 14.7614 22 12 22H10C7.23858 22 5 19.7614 5 17V12Z"/><path d="M17 13H19C20.1046 13 21 13.8954 21 15V15C21 16.1046 20.1046 17 19 17H17"/><path d="M9 9C9 9 8 8.5 8 7C8 5.5 9 5 9 5"/><path d="M12 3C12 3 13 3.5 13 5C13 6.5 12 7 12 7"/>
              </svg>
            )},
            { id: "words", label: t.words, badge: null, icon: (active) => (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? T.text : T.textTertiary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 6s-2-2-4-2-5 2-5 2v14s3-2 5-2 4 2 4 2c1.333-1.333 2.667-2 4-2 1.333 0 3 .667 5 2V6c-2-1.333-3.667-2-5-2-1.333 0-2.667.667-4 2z"/><path strokeLinecap="round" d="M12 6v14"/>
              </svg>
            )},
            { id: "chat", label: t.chat, badge: null, icon: (active) => (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? T.text : T.textTertiary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8.82388455,18.5880577 L4,21 L4.65322944,16.4273939 C3.00629211,15.0013 2,13.0946628 2,11 C2,6.581722 6.4771525,3 12,3 C17.5228475,3 22,6.581722 22,11 C22,15.418278 17.5228475,19 12,19 C10.8897425,19 9.82174472,18.8552518 8.82388455,18.5880577 Z"/>
              </svg>
            )},
            { id: "heatmap", label: t.progress, badge: null, icon: (active) => (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={active ? T.text : T.textTertiary} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 14l8-11v7h5l-8 11v-7z"/>
              </svg>
            )},
          ].map((tab) => {
            const active = view === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setView(tab.id)}
                style={{
                  flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                  background: active ? (settings.theme === "dark" ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.06)") : "none", border: "none",
                  borderRadius: 9999, padding: "6px 4px",
                  cursor: "pointer",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  {tab.icon(active)}
                  {tab.badge && (
                    <span style={{
                      background: T.accent, color: T.bg,
                      fontFamily: font.mono, fontSize: 7, fontWeight: 600,
                      padding: "1px 4px", borderRadius: 9999, whiteSpace: "nowrap",
                    }}>
                      {tab.badge}
                    </span>
                  )}
                </span>
                <span style={{
                  fontFamily: font.body, fontSize: 9, fontWeight: active ? 700 : 500,
                  color: active ? T.text : T.textTertiary,
                  textTransform: "capitalize", letterSpacing: 0.2,
                }}>
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
