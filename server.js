// ============================================================
//  단어 승부 (word-duel) 서버
//  - 방 만들기(초대 코드) 또는 랜덤 매칭 기반 커플 대결 글자 게임
//  - 글자 선택(easy/medium 5초, hard 7초) -> 공개 -> 단어 레이스(난도별 제한시간)
//  - 3선, 이긴 사람이 다음 라운드 선(先)이 됨
// ============================================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- 단어 제안함 (관리자만 확인 가능, 파일로 저장) ----------
const SUGGESTIONS_FILE = path.join(__dirname, 'suggestions.json');
let suggestions = [];
try {
  suggestions = JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf8'));
} catch {
  suggestions = [];
}
function saveSuggestions() {
  fs.writeFile(SUGGESTIONS_FILE, JSON.stringify(suggestions, null, 2), () => {});
}

function escapeHtmlServer(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

app.get('/admin/suggestions', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    res.status(404).send('Not found');
    return;
  }
  const rows = suggestions
    .slice()
    .reverse()
    .map((s) => `<tr><td>${new Date(s.at).toLocaleString('ko-KR')}</td><td>${escapeHtmlServer(s.word)}</td><td>${escapeHtmlServer(s.nickname)}</td></tr>`)
    .join('');
  res.send(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><title>단어 제안함</title>
    <style>body{font-family:sans-serif;padding:24px;} table{border-collapse:collapse;width:100%;} td,th{border:1px solid #ddd;padding:8px;text-align:left;} th{background:#f4f4f4;}</style>
    </head><body><h1>단어 제안함 (${suggestions.length}건)</h1>
    <table><tr><th>시각</th><th>제안 단어</th><th>닉네임</th></tr>${rows}</table></body></html>`);
});

// ---------- 시간 설정 (TIME_SCALE로 테스트 시 배속 조절 가능) ----------
const TIME_SCALE = Number(process.env.TIME_SCALE) || 1;
function scaled(ms) {
  return Math.max(200, Math.round(ms * TIME_SCALE));
}

const MATCH_DELAY = 2000;         // 매칭 후 첫 라운드 시작까지 연출 시간
const ROUND_END_PAUSE = 2500;     // 라운드 결과 표시 후 다음 라운드까지 대기
const VOTE_TIME = 30000;          // 재대결 투표 제한 시간

// wordTime: null이면 단어 제출 단계에 시간 제한이 없음(EASY)
const DIFFICULTY = {
  easy: { letterTime: 5000, wordTime: null, orderMatters: false, minLength: 1, label: 'EASY' },
  medium: { letterTime: 5000, wordTime: 15000, orderMatters: true, minLength: 1, label: 'MEDIUM' },
  hard: { letterTime: 7000, wordTime: 10000, orderMatters: true, minLength: 5, label: 'HARD' },
};
const WINS_NEEDED = 3; // 3선

// ---------- 글자 풀 ----------
const ALPHABET_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function randomLetter() {
  return ALPHABET_POOL[Math.floor(Math.random() * ALPHABET_POOL.length)];
}
function isValidLetter(raw) {
  const up = String(raw || '').trim().toUpperCase();
  return ALPHABET_POOL.includes(up) ? up : null;
}

function letterStats(word, letter) {
  const lower = word.toLowerCase();
  const target = letter.toLowerCase();
  let count = 0;
  let firstPos = Infinity;
  let lastPos = -Infinity;
  for (let i = 0; i < lower.length; i += 1) {
    if (lower[i] === target) {
      count += 1;
      if (firstPos === Infinity) firstPos = i;
      lastPos = i;
    }
  }
  return { count, firstPos, lastPos };
}

// ---------- 영어 사전 (nspell + dictionary-en, ESM이라 동적 import로 로드) ----------
let spellEn = null;
async function loadEnglishSpellChecker() {
  const { default: nspell } = await import('nspell');
  const { default: dictEn } = await import('dictionary-en');
  spellEn = nspell(dictEn);
  console.log('영어 사전 로드 완료');
}

// ---------- 국가 이름 (일반 영어 사전엔 고유명사라 빠져있어서 별도로 인정) ----------
const COUNTRY_NAMES = new Set([
  'afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'antigua and barbuda',
  'argentina', 'armenia', 'australia', 'austria', 'azerbaijan',
  'bahamas', 'bahrain', 'bangladesh', 'barbados', 'belarus', 'belgium', 'belize',
  'benin', 'bhutan', 'bolivia', 'bosnia and herzegovina', 'botswana', 'brazil',
  'britain', 'brunei', 'bulgaria', 'burkina faso', 'burundi',
  'cambodia', 'cameroon', 'canada', 'chad', 'chile', 'china', 'colombia',
  'comoros', 'congo', 'costa rica', 'croatia', 'cuba', 'cyprus', 'czechia', 'czech republic',
  'denmark', 'djibouti', 'dominica', 'dominican republic',
  'ecuador', 'egypt', 'england', 'el salvador', 'eritrea', 'estonia', 'eswatini', 'ethiopia',
  'fiji', 'finland', 'france',
  'gabon', 'gambia', 'georgia', 'germany', 'ghana', 'greece', 'grenada', 'guatemala',
  'guinea', 'guyana',
  'haiti', 'holland', 'honduras', 'hungary',
  'iceland', 'india', 'indonesia', 'iran', 'iraq', 'ireland', 'israel', 'italy',
  'jamaica', 'japan', 'jordan',
  'kazakhstan', 'kenya', 'kiribati', 'korea', 'kosovo', 'kuwait', 'kyrgyzstan',
  'laos', 'latvia', 'lebanon', 'lesotho', 'liberia', 'libya', 'liechtenstein',
  'lithuania', 'luxembourg',
  'madagascar', 'malawi', 'malaysia', 'maldives', 'mali', 'malta', 'mauritania',
  'mauritius', 'mexico', 'moldova', 'monaco', 'mongolia', 'montenegro', 'morocco',
  'mozambique', 'myanmar',
  'namibia', 'nauru', 'nepal', 'netherlands', 'nicaragua', 'niger', 'nigeria',
  'norway',
  'oman',
  'pakistan', 'palau', 'palestine', 'panama', 'paraguay', 'peru', 'philippines',
  'poland', 'portugal',
  'qatar',
  'romania', 'russia', 'rwanda',
  'samoa', 'senegal', 'serbia', 'seychelles', 'singapore', 'slovakia', 'slovenia',
  'somalia', 'spain', 'sudan', 'suriname', 'sweden', 'switzerland', 'syria',
  'taiwan', 'tajikistan', 'tanzania', 'thailand', 'togo', 'tonga', 'tunisia',
  'turkey', 'turkmenistan', 'tuvalu',
  'uganda', 'ukraine', 'uruguay', 'uzbekistan',
  'vanuatu', 'vatican', 'venezuela', 'vietnam',
  'wales',
  'yemen',
  'zambia', 'zimbabwe',
  'united states', 'america', 'united kingdom', 'united arab emirates',
  'north korea', 'south korea', 'north macedonia', 'macedonia',
  'papua new guinea', 'marshall islands', 'solomon islands', 'sri lanka',
  'saudi arabia', 'sierra leone', 'south africa', 'south sudan',
  'trinidad and tobago', 'new zealand', 'ivory coast',
]);

// ---------- 단어 검증 ----------
function validateWord(game, socketId, rawWord) {
  const word = String(rawWord || '').trim();
  if (!word) return { ok: false, reason: '단어를 입력해주세요.' };

  const cfg = DIFFICULTY[game.difficulty];
  const bareLength = word.replace(/\s+/g, '').length;
  if (bareLength < cfg.minLength) {
    return { ok: false, reason: `${cfg.minLength}글자 이상이어야 해요.` };
  }

  const [p1, p2] = game.players;
  const dealerId = game.dealerId;
  const otherId = dealerId === p1.id ? p2.id : p1.id;
  const dealerLetter = game.letters[dealerId];
  const otherLetter = game.letters[otherId];
  const sameLetter = dealerLetter === otherLetter;

  const dStats = letterStats(word, dealerLetter);
  const oStats = sameLetter ? dStats : letterStats(word, otherLetter);

  if (sameLetter) {
    if (dStats.count < 2) return { ok: false, reason: `"${dealerLetter}" 글자가 두 번 들어가야 해요.` };
  } else {
    if (dStats.count < 1) return { ok: false, reason: `"${dealerLetter}" 글자가 아직 없어요.` };
    if (oStats.count < 1) return { ok: false, reason: `"${otherLetter}" 글자가 아직 없어요.` };
  }

  if (cfg.orderMatters && !sameLetter) {
    // 선 글자가 후 글자보다 앞서는 조합이 하나라도 있으면 인정 (첫 등장끼리만 비교하지 않음)
    if (!(dStats.firstPos < oStats.lastPos)) {
      return { ok: false, reason: `"${dealerLetter}" 글자가 "${otherLetter}" 글자보다 먼저 나와야 해요.` };
    }
  }

  const isCountryName = COUNTRY_NAMES.has(word.toLowerCase());
  if (!isCountryName && (!spellEn || !spellEn.correct(word.toLowerCase()))) {
    return { ok: false, reason: '사전에 없는 단어예요.' };
  }

  return { ok: true, word };
}

// ---------- 방/게임 상태 ----------
const openRooms = new Map(); // 초대 코드 -> 호스트 소켓
const games = new Map();     // roomId -> 게임 상태
let waitingPlayer = null;    // 랜덤 매칭 대기 중인 소켓 (한 명만 대기)

function randomDifficulty() {
  const options = ['easy', 'medium', 'hard'];
  return options[Math.floor(Math.random() * options.length)];
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (openRooms.has(code));
  return code;
}
function cleanNickname(nickname) {
  return String(nickname || '익명').trim().slice(0, 12) || '익명';
}
function leaveWaitingStates(socket) {
  if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
  if (socket.data.hostCode) {
    openRooms.delete(socket.data.hostCode);
    socket.data.hostCode = null;
  }
}

// 두 플레이어 각자의 시점(mine/theirs)으로 이벤트를 보냄
function emitPerspective(game, eventName, build) {
  const [p1, p2] = game.players;
  p1.emit(eventName, build(p1, p2));
  p2.emit(eventName, build(p2, p1));
}

io.on('connection', (socket) => {
  // ---------- 랜덤 매칭 (난도는 랜덤으로 결정) ----------
  socket.on('join_queue', (nickname) => {
    if (socket.data.roomId) return;
    leaveWaitingStates(socket);
    socket.data.nickname = cleanNickname(nickname);

    if (waitingPlayer && waitingPlayer.connected && waitingPlayer.id !== socket.id) {
      const p1 = waitingPlayer;
      waitingPlayer = null;
      startMatch(p1, socket, { difficulty: randomDifficulty() });
    } else {
      waitingPlayer = socket;
      socket.emit('waiting');
    }
  });

  socket.on('create_room', ({ nickname, difficulty } = {}) => {
    if (socket.data.roomId) return;
    leaveWaitingStates(socket);
    socket.data.nickname = cleanNickname(nickname);

    const diff = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'easy';

    const code = makeRoomCode();
    socket.data.hostCode = code;
    socket.data.hostConfig = { difficulty: diff };
    openRooms.set(code, socket);
    socket.emit('room_created', { code, difficulty: diff });
  });

  socket.on('join_room', ({ nickname, code } = {}) => {
    if (socket.data.roomId) return;
    leaveWaitingStates(socket);
    socket.data.nickname = cleanNickname(nickname);

    const host = openRooms.get(String(code || '').trim().toUpperCase());
    if (!host || !host.connected || host.id === socket.id) {
      socket.emit('room_error', { message: '해당 코드의 방을 찾을 수 없어요.' });
      return;
    }
    openRooms.delete(host.data.hostCode);
    host.data.hostCode = null;
    startMatch(host, socket, host.data.hostConfig);
  });

  socket.on('cancel_waiting', () => leaveWaitingStates(socket));

  // ---------- 단어 제안 (관리자만 확인, 게임과 무관하게 아무 때나 가능) ----------
  socket.on('submit_suggestion', ({ word, nickname } = {}) => {
    const cleanWord = String(word || '').trim().slice(0, 30);
    if (!cleanWord) {
      socket.emit('suggestion_rejected', { message: '단어를 입력해주세요.' });
      return;
    }
    suggestions.push({
      word: cleanWord,
      nickname: cleanNickname(nickname),
      at: Date.now(),
    });
    saveSuggestions();
    socket.emit('suggestion_submitted');
  });

  // ---------- 글자 선택 (탭 방식) ----------
  socket.on('submit_letter', (raw) => {
    const game = games.get(socket.data.roomId);
    if (!game || game.phase !== 'letter') return;
    if (game.letters[socket.id] !== undefined) return;

    const letter = isValidLetter(raw);
    if (!letter) return; // 정상 UI라면 발생하지 않음 (버튼 탭 기반)

    game.letters[socket.id] = letter;
    socket.to(game.roomId).emit('opponent_letter_submitted');

    const [p1, p2] = game.players;
    if (game.letters[p1.id] !== undefined && game.letters[p2.id] !== undefined) {
      clearTimeout(game.timer);
      endLetterPhase(game);
    }
  });

  // ---------- 단어 제출 (레이스) ----------
  socket.on('submit_word', (raw) => {
    const game = games.get(socket.data.roomId);
    if (!game || game.phase !== 'word') return;

    const result = validateWord(game, socket.id, raw);
    if (!result.ok) {
      socket.emit('word_rejected', { message: result.reason });
      return;
    }

    // 레이스이므로 가장 먼저 유효 단어를 낸 사람이 그 라운드 승자
    finishRound(game, { winnerId: socket.id, word: result.word });
  });

  // ---------- 라운드 패스 투표 (주로 시간 제한이 없는 EASY에서 사용, 둘 다 눌러야 성립) ----------
  socket.on('pass_round', () => {
    const game = games.get(socket.data.roomId);
    if (!game || game.phase !== 'word') return;
    if (game.passVotes[socket.id]) return; // 이미 패스함

    game.passVotes[socket.id] = true;
    socket.to(game.roomId).emit('opponent_passed');

    const [p1, p2] = game.players;
    if (game.passVotes[p1.id] && game.passVotes[p2.id]) {
      finishRound(game, { draw: true });
    }
  });

  // ---------- 재대결 투표 ----------
  socket.on('vote_rematch', (agree) => {
    const game = games.get(socket.data.roomId);
    if (!game || game.phase !== 'matchEnd') return;
    if (game.rematchVotes[socket.id] !== undefined) return;

    game.rematchVotes[socket.id] = !!agree;
    socket.to(game.roomId).emit('opponent_voted_rematch', { agree: !!agree });

    const votes = Object.values(game.rematchVotes);
    if (votes.includes(false)) {
      clearTimeout(game.timer);
      io.to(game.roomId).emit('rematch_result', { continue: false, reason: 'declined' });
      cleanupGame(game);
    } else if (votes.length === 2) {
      clearTimeout(game.timer);
      resetMatch(game);
      io.to(game.roomId).emit('rematch_result', { continue: true });
      game.timer = setTimeout(() => startRound(game), scaled(MATCH_DELAY));
    }
  });

  // ---------- 나가기 / 연결 종료 ----------
  socket.on('leave_game', () => {
    leaveWaitingStates(socket);
    const game = games.get(socket.data.roomId);
    if (game) {
      clearTimeout(game.timer);
      socket.to(game.roomId).emit('opponent_left');
      cleanupGame(game);
    }
  });

  socket.on('disconnect', () => {
    leaveWaitingStates(socket);
    const game = games.get(socket.data.roomId);
    if (game) {
      clearTimeout(game.timer);
      socket.to(game.roomId).emit('opponent_left');
      cleanupGame(game);
    }
  });
});

// ---------- 매치 시작 ----------
function startMatch(p1, p2, config) {
  const roomId = `duel-${p1.id}-${p2.id}`;
  [p1, p2].forEach((p) => {
    p.join(roomId);
    p.data.roomId = roomId;
  });

  const game = {
    roomId,
    players: [p1, p2],
    difficulty: config.difficulty,
    round: 0,
    score: { [p1.id]: 0, [p2.id]: 0 },
    dealerId: Math.random() < 0.5 ? p1.id : p2.id,
    phase: 'idle',
    letters: {},
    passVotes: {},
    history: [],
    rematchVotes: {},
    timer: null,
  };
  games.set(roomId, game);

  emitPerspective(game, 'match_start', (self, opp) => ({
    opponent: opp.data.nickname,
    difficulty: game.difficulty,
    dealerIsMe: game.dealerId === self.id,
  }));

  game.timer = setTimeout(() => startRound(game), scaled(MATCH_DELAY));
}

function resetMatch(game) {
  const [p1, p2] = game.players;
  game.round = 0;
  game.score = { [p1.id]: 0, [p2.id]: 0 };
  game.dealerId = Math.random() < 0.5 ? p1.id : p2.id;
  game.phase = 'idle';
  game.letters = {};
  game.history = [];
  game.rematchVotes = {};
}

// ---------- 라운드: 글자 선택 단계 ----------
function startRound(game) {
  if (!games.has(game.roomId)) return;
  game.round += 1;
  game.phase = 'letter';
  game.letters = {};

  const cfg = DIFFICULTY[game.difficulty];
  const time = scaled(cfg.letterTime);

  emitPerspective(game, 'letter_phase_start', (self) => ({
    round: game.round,
    time,
    dealerIsMe: game.dealerId === self.id,
    pool: ALPHABET_POOL,
  }));

  game.timer = setTimeout(() => endLetterPhase(game), time + 300);
}

function endLetterPhase(game) {
  if (!games.has(game.roomId) || game.phase !== 'letter') return;

  const [p1, p2] = game.players;
  [p1, p2].forEach((p) => {
    if (game.letters[p.id] === undefined) {
      game.letters[p.id] = randomLetter();
    }
  });

  game.phase = 'word';
  game.passVotes = {};
  const cfg = DIFFICULTY[game.difficulty];
  const time = cfg.wordTime === null ? null : scaled(cfg.wordTime);

  emitPerspective(game, 'round_reveal', (self, opp) => ({
    round: game.round,
    mine: game.letters[self.id],
    theirs: game.letters[opp.id],
    dealerIsMe: game.dealerId === self.id,
    orderMatters: cfg.orderMatters,
    minLength: cfg.minLength,
    time, // null이면 시간 제한 없음
  }));

  game.timer = time === null ? null : setTimeout(() => endWordPhaseTimeout(game), time + 300);
}

function endWordPhaseTimeout(game) {
  if (!games.has(game.roomId) || game.phase !== 'word') return;
  finishRound(game, { draw: true });
}

// ---------- 라운드 종료 (승리 또는 무승부) ----------
function finishRound(game, { winnerId, word, draw }) {
  if (!games.has(game.roomId) || game.phase !== 'word') return;
  clearTimeout(game.timer);
  game.phase = 'roundEnd';

  const [p1, p2] = game.players;

  if (!draw) {
    game.score[winnerId] += 1;
    game.dealerId = winnerId;
  } else {
    game.dealerId = Math.random() < 0.5 ? p1.id : p2.id;
  }

  game.history.push({
    round: game.round,
    letters: { [p1.id]: game.letters[p1.id], [p2.id]: game.letters[p2.id] },
    winnerId: draw ? null : winnerId,
    word: draw ? null : word,
  });

  emitPerspective(game, 'round_result', (self, opp) => ({
    round: game.round,
    draw: !!draw,
    iWon: !draw && winnerId === self.id,
    opponentWon: !draw && winnerId === opp.id,
    word: draw ? null : word,
    myScore: game.score[self.id],
    oppScore: game.score[opp.id],
    dealerIsMeNext: game.dealerId === self.id,
    myLetter: game.letters[self.id],
    oppLetter: game.letters[opp.id],
  }));

  if (!draw && game.score[winnerId] >= WINS_NEEDED) {
    // 승리 단어를 잠시 보여준 뒤에 매치 종료 화면으로 넘어가도록 동일한 딜레이를 둠
    game.timer = setTimeout(() => matchEnd(game, winnerId), scaled(ROUND_END_PAUSE));
  } else {
    game.timer = setTimeout(() => startRound(game), scaled(ROUND_END_PAUSE));
  }
}

// ---------- 매치 종료 ----------
function matchEnd(game, winnerId) {
  game.phase = 'matchEnd';
  game.rematchVotes = {};

  emitPerspective(game, 'match_end', (self, opp) => ({
    iWon: winnerId === self.id,
    myScore: game.score[self.id],
    oppScore: game.score[opp.id],
  }));

  game.timer = setTimeout(() => {
    if (!games.has(game.roomId) || game.phase !== 'matchEnd') return;
    io.to(game.roomId).emit('rematch_result', { continue: false, reason: 'timeout' });
    cleanupGame(game);
  }, scaled(VOTE_TIME));
}

// ---------- 게임 정리 ----------
function cleanupGame(game) {
  clearTimeout(game.timer);
  games.delete(game.roomId);
  game.players.forEach((p) => {
    p.data.roomId = null;
    p.leave(game.roomId);
  });
}

const PORT = process.env.PORT || 3001;
loadEnglishSpellChecker()
  .catch((err) => {
    console.error('영어 사전 로드 실패, 단어 검증이 항상 실패합니다:', err);
  })
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`서버 실행 중 → http://localhost:${PORT}`);
    });
  });
