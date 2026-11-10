'use strict';

/*
 * bgm.js — WebAudio API로 배경음악을 "합성"한다 (음악 파일 없음)
 *
 * 곡: 이 프로젝트용으로 새로 쓴 16마디 곡 2개 (TRACKS). 곡을 추가하려면 TRACKS에 항목만 더하면 된다
 * 흐름: 악보(문자열) → parse()로 스텝 배열 → 스케줄러가 조금 앞서 예약 → 오실레이터가 소리를 낸다
 *
 * 왜 "미리 예약"하나?
 *  setInterval 타이머는 수 ms~수십 ms씩 밀린다. 타이머로 직접 소리를 내면 박자가 흔들린다.
 *  그래서 타이머는 "다음 0.12초 안에 날 음"을 AudioContext의 정밀한 시계(currentTime)에 예약만 하고,
 *  실제 발음 시각은 오디오 엔진이 지킨다. 배치 스케줄러가 작업을 큐에 미리 넣어 두는 것과 같다.
 *
 * 외부에 공개하는 것은 BGM 객체 하나뿐이다(tetris.js가 상태가 바뀔 때 play/pause/stop을 부른다).
 */
const BGM = (() => {
  const STORAGE_ENABLED = 'block-stacker.bgm';
  const STORAGE_TRACK = 'block-stacker.bgm-track';
  const STEPS_PER_BAR = 8; // 1스텝 = 8분음표
  const LOOKAHEAD = 0.12;  // 몇 초 앞까지 미리 예약할지
  const TICK_MS = 25;      // 스케줄러가 깨어나는 주기

  /*
   * 악보 표기: "음이름옥타브:길이". 길이는 8분음표 개수(생략하면 1), "-"는 쉼표, "|"는 마디 구분(읽을 때 무시)
   * bass: 마디별 근음. "쿵-짝"으로 근음 → 5도를 4분음표로 번갈아 친다
   */
  const TRACKS = [
    {
      id: 'neon',
      title: '네온 스텝',
      description: 'A단조 · 경쾌한 8비트',
      baseBpm: 132,
      voices: {
        lead: { type: 'square', gain: 0.06, release: 0.9 },    // 사각파: 8비트 게임기 소리
        bass: { type: 'triangle', gain: 0.18, release: 0.85 }, // 삼각파: 부드러운 저음
      },
      melody: [
        'A4:2 C5 E5 A5:2 G5 E5 | F5:2 E5 D5 E5:3 - | D5 E5 F5 D5 C5:2 B4 C5 | B4:2 G#4 B4 E5:4',
        'A4:2 C5 E5 A5:2 B5 C6 | B5:2 A5 G5 F5:2 E5:2 | D5 F5 E5 C5 B4:2 G#4:2 | A4:6 -:2',
        'E5 E5 G5:2 C6:2 B5 A5 | G5:2 D5:2 G5:3 - | A5 G5 F5 E5 F5:2 A5:2 | G#5:2 E5:2 B4:3 -',
        'C5 D5 E5 F5 G5:2 A5:2 | F5 E5 D5 C5 D5:2 B4:2 | C5 B4 A4 B4 C5 D5 E5 G#5 | A5:6 -:2',
      ].join(' | '),
      bass: ['A2', 'D3', 'D3', 'E2', 'A2', 'F2', 'E2', 'A2', 'C3', 'G2', 'F2', 'E2', 'C3', 'D3', 'E2', 'A2'],
    },
    {
      id: 'folk',
      title: '광장의 춤',
      description: 'D단조 · 민속 춤곡풍',
      baseBpm: 144,
      voices: {
        lead: { type: 'sawtooth', gain: 0.035, release: 0.8 }, // 톱니파: 아코디언 느낌
        bass: { type: 'square', gain: 0.07, release: 0.6 },
      },
      melody: [
        'D5 F5 A5 F5 D5:2 A4:2 | G4 A4 Bb4 D5 G5:3 - | E5 G5 C6:2 Bb5 A5 G5:2 | A5:2 F5 C5 F5:4',
        'D5 Bb4 F5 D5 Bb5:2 A5:2 | G5 F5 E5 D5 E5:2 G5:2 | A5 G5 F5 E5 C#5:2 E5:2 | D5:6 -:2',
        'C6 A5 F5 A5 C6:2 A5:2 | G5 E5 C5 E5 G5:3 - | F5 E5 D5 E5 F5 A5 D6:2 | C#6:2 A5:2 E5:3 -',
        'D6 C6 Bb5 A5 G5:2 Bb5:2 | A5 G5 F5 E5 D5:2 G5:2 | F5 E5 D5 C#5 D5 E5 F5 G5 | D5:6 -:2',
      ].join(' | '),
      bass: ['D3', 'G2', 'C3', 'F2', 'Bb2', 'G2', 'A2', 'D3', 'F2', 'C3', 'D3', 'A2', 'Bb2', 'G2', 'A2', 'D3'],
    },
  ];

  // ===== 악보 → 스텝 배열 =====
  const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function toMidi(name) {
    const m = /^([A-G])(#|b)?(\d)$/.exec(name);
    if (!m) throw new Error(`잘못된 음이름: ${name}`);
    const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
    return 12 * (Number(m[3]) + 1) + SEMITONES[m[1]] + accidental; // A4 = 69
  }

  function parse(score) {
    const notes = [];
    let step = 0;
    score.split(/\s+/).forEach((token) => {
      if (!token || token === '|') return;
      const [name, len = '1'] = token.split(':');
      const dur = Number(len);
      if (name !== '-') notes.push({ step, midi: toMidi(name), dur });
      step += dur;
    });
    return { notes, length: step };
  }

  // 곡 하나를 timeline[스텝] = [그 스텝에서 시작하는 음…] 형태로 바꾼다
  function compile(track) {
    const loopSteps = track.bass.length * STEPS_PER_BAR;
    const lead = parse(track.melody);
    if (lead.length !== loopSteps) {
      console.warn(`BGM '${track.id}' 멜로디 길이(${lead.length})가 베이스(${loopSteps})와 다릅니다`);
    }
    const timeline = Array.from({ length: loopSteps }, () => []);
    lead.notes.forEach((n) => timeline[n.step % loopSteps].push({ midi: n.midi, dur: n.dur, voice: 'lead' }));
    track.bass.forEach((root, bar) => {
      const r = toMidi(root);
      [r, r + 7, r, r + 7].forEach((midi, beat) => {
        timeline[bar * STEPS_PER_BAR + beat * 2].push({ midi, dur: 2, voice: 'bass' });
      });
    });
    return { ...track, timeline, loopSteps, melodySteps: lead.length };
  }

  const compiled = TRACKS.map(compile);

  // ===== 재생 상태 =====
  let ctx = null;       // AudioContext: 브라우저 정책상 사용자가 클릭·키 입력을 한 뒤에 만들어야 소리가 난다
  let unlocked = false; // 사용자가 이 페이지에서 한 번이라도 입력했는지
  let bus = null;       // 한 번 재생할 때마다 새로 만드는 출력 노드(정지할 때 끊어서 예약된 음을 버린다)
  let timer = null;
  let mode = 'stopped'; // 게임이 원하는 상태: 'stopped' | 'playing' | 'paused'
  let enabled = load(STORAGE_ENABLED) !== 'off';
  let track = compiled.find((t) => t.id === load(STORAGE_TRACK)) || compiled[0];
  let level = 1;
  let step = 0;
  let nextTime = 0;

  function load(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 저장할 수 없는 환경이면 이번 세션에서만 기억한다 */
    }
  }

  // 레벨이 오를수록 빨라진다: 곡의 기본 템포에서 레벨당 +6, 최대 200
  function bpm() {
    return Math.min(200, track.baseBpm + (level - 1) * 6);
  }

  function secondsPerStep() {
    return 60 / bpm() / 2; // 8분음표 = 4분음표 한 박의 절반
  }

  function ensureContext() {
    if (ctx) return true;
    if (!unlocked) return false; // 사용자 입력 전에는 만들지 않는다(만들어도 소리가 막히고 경고만 뜬다)
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false; // WebAudio를 지원하지 않으면 조용히 음악 없이 진행
    ctx = new AudioCtx();
    return true;
  }

  function playNote(note, time) {
    const voice = track.voices[note.voice];
    const length = note.dur * secondsPerStep();
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = voice.type;
    osc.frequency.setValueAtTime(440 * Math.pow(2, (note.midi - 69) / 12), time);
    // 볼륨 곡선: 0.01초 만에 올라갔다가(딸깍 소리 방지) 서서히 줄어든다
    amp.gain.setValueAtTime(0.0001, time);
    amp.gain.exponentialRampToValueAtTime(voice.gain, time + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, time + length * voice.release);
    osc.connect(amp).connect(bus);
    osc.start(time);
    osc.stop(time + length);
  }

  // 다음 LOOKAHEAD초 안에 시작할 음을 모두 예약한다
  function schedule() {
    while (nextTime < ctx.currentTime + LOOKAHEAD) {
      track.timeline[step].forEach((note) => playNote(note, nextTime));
      nextTime += secondsPerStep();
      step = (step + 1) % track.loopSteps;
    }
  }

  function startScheduler() {
    bus = ctx.createGain();
    bus.connect(ctx.destination);
    step = 0;
    nextTime = ctx.currentTime + 0.05;
    schedule();
    timer = setInterval(schedule, TICK_MS);
  }

  function stopScheduler() {
    clearInterval(timer);
    timer = null;
    if (bus) {
      bus.disconnect();
      bus = null;
    }
  }

  // 소리가 나는 조건은 단 하나: 켜져 있고(enabled) 게임이 진행 중(mode === 'playing')
  // 일시정지는 AudioContext의 시계 자체를 멈춘다(suspend) → 재개하면 멈춘 박자부터 이어진다
  function apply() {
    if (mode === 'stopped') stopScheduler();
    if (enabled && mode === 'playing') {
      if (!ensureContext()) return;
      if (!timer) startScheduler();
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    } else if (ctx && ctx.state === 'running') {
      ctx.suspend().catch(() => {});
    }
  }

  // 첫 사용자 입력에서 잠금 해제. capture 단계라 게임의 키·버튼 처리보다 먼저 실행된다
  // (랜딩 페이지에서 "플레이"로 넘어와 자동 시작한 경우, 첫 키 입력·터치 순간 음악이 시작된다)
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    apply();
  }
  ['pointerdown', 'keydown'].forEach((type) => window.addEventListener(type, unlock, { capture: true }));

  return {
    play() {
      mode = 'playing';
      apply();
    },
    pause() {
      if (mode !== 'playing') return;
      mode = 'paused';
      apply();
    },
    stop() {
      mode = 'stopped';
      apply();
    },
    setLevel(value) {
      level = value;
    },
    toggle() {
      enabled = !enabled;
      save(STORAGE_ENABLED, enabled ? 'on' : 'off');
      apply();
      return enabled;
    },
    // 곡 바꾸기: 지금 예약된 음을 버리고, 다음에 재생할 때 새 곡 처음부터 시작한다
    setTrack(id) {
      const next = compiled.find((t) => t.id === id);
      if (!next || next === track) return false;
      track = next;
      save(STORAGE_TRACK, id);
      stopScheduler();
      apply();
      return true;
    },
    // 다음 곡으로 (마지막 다음은 첫 곡)
    nextTrack() {
      const i = compiled.indexOf(track);
      this.setTrack(compiled[(i + 1) % compiled.length].id);
      return track.id;
    },
    get tracks() {
      return compiled.map(({ id, title, description, loopSteps, melodySteps }) => ({ id, title, description, loopSteps, melodySteps }));
    },
    get track() {
      return { id: track.id, title: track.title, description: track.description };
    },
    get enabled() {
      return enabled;
    },
    get bpm() {
      return bpm();
    },
  };
})();
