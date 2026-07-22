import { questions as defaultQuestions } from './questions.js';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

// LocalStorage 키
const STORAGE_KEY = 'ox_quiz_questions';
const TIMER_LIMIT_KEY = 'ox_quiz_timer_limit';
const QUESTION_COUNT_KEY = 'ox_quiz_question_count';
const TTS_ENABLED_KEY = 'ox_quiz_tts_enabled';

// 관절 연결 구조 정의 (스켈레톤 드로잉용 한글 주석 적용)
const POSE_CONNECTIONS = [
  [11, 12], // 양쪽 어깨 연결선
  [11, 13], [13, 15], // 왼팔 (어깨 - 팔꿈치 - 손목)
  [12, 14], [14, 16], // 오른팔 (어깨 - 팔꿈치 - 손목)
  [11, 23], [12, 24], [23, 24], // 몸통 (어깨 - 골반)
  [23, 25], [25, 27], // 왼다리 (골반 - 무릎 - 발목)
  [24, 26], [26, 28]  // 오른다리 (골반 - 무릎 - 발목)
];

// ==========================================
// 1. 전역 상태 및 DOM 요소 초기화
// ==========================================
const state = {
  screen: 'home',
  currentQuestionIndex: 0,
  score: 0,
  timer: 15,
  timerInterval: null,
  feedbackTimeout: null, // 다음 문제 전환 대기 타이머 식별자 (중도 퇴장 시 정리용)
  questions: [], // 실제 플레이할 무작위 문항 리스트
  
  // 선생님 방 추가 설정값 (초기값 지정 후 localStorage 로드 예정)
  limitTime: 15,
  questionCount: 5,
  ttsEnabled: true,
  
  // 카메라 및 동작 인식 상태
  webcamStream: null,
  poseLandmarker: null,
  isTrackingReady: false,
  isCalibrated: false,
  currentLandmarks: null, // 현재 프레임의 관절 랜드마크 저장소
  showSkeleton: true,     // 관절 스켈레톤 시각화 표시 여부
  
  // 포인터 좌표 (보간 적용)
  pointer: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  targetPointer: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  isHandActive: false,
  
  // 선택 진행 상태 (Dwell Time)
  dwellO: 0,
  dwellX: 0,
  targetDwellTime: 1200, // 1.2초 유지
  lastFrameTime: performance.now(),
  
  // 오디오 활성화 여부
  audioEnabled: false
};

// DOM 요소 캐싱
const els = {
  screens: {
    home: document.getElementById('screen-home'),
    calibration: document.getElementById('screen-calibration'),
    quiz: document.getElementById('screen-quiz'),
    result: document.getElementById('screen-result'),
    admin: document.getElementById('screen-admin')
  },
  btnStart: document.getElementById('btn-start'),
  btnCalBack: document.getElementById('btn-cal-back'),
  btnCalReady: document.getElementById('btn-cal-ready'),
  btnRestart: document.getElementById('btn-restart'),
  
  // 퀴즈 화면 요소
  currentQuestionNum: document.getElementById('current-question-num'),
  totalQuestionsNum: document.getElementById('total-questions-num'),
  timerBar: document.getElementById('timer-bar'),
  timerText: document.getElementById('timer-text'),
  scoreStars: document.getElementById('score-stars'),
  questionText: document.getElementById('question-text'),
  btnQuizExit: document.getElementById('btn-quiz-exit'), // 나가기 버튼 캐싱
  
  // OX 버튼 구역
  zoneO: document.getElementById('zone-o'),
  zoneX: document.getElementById('zone-x'),
  dwellOProgress: document.getElementById('dwell-o-progress'),
  dwellXProgress: document.getElementById('dwell-x-progress'),
  oBtn: document.querySelector('.o-btn'),
  xBtn: document.querySelector('.x-btn'),
  
  // 카메라 관련
  webcam: document.getElementById('webcam'),
  cameraOverlay: document.getElementById('camera-overlay'),
  cameraLoading: document.getElementById('camera-loading'),
  trackingStatus: document.getElementById('tracking-status'),
  
  // 피드백 오버레이
  feedbackOverlay: document.getElementById('feedback-overlay'),
  feedbackSymbol: document.getElementById('feedback-symbol'),
  feedbackTitle: document.getElementById('feedback-title'),
  feedbackDesc: document.getElementById('feedback-desc'),
  
  // 결과 화면
  finalCorrectCount: document.getElementById('final-correct-count'),
  finalTotalCount: document.getElementById('final-total-count'),
  finalStarsContainer: document.getElementById('final-stars-container'),
  resultTrophyEmoji: document.getElementById('result-trophy-emoji'),
  resultMessage: document.getElementById('result-message'),
  
  // 캔버스
  pointerCanvas: document.getElementById('pointer-canvas'),

  // 교사용 관리 페이지 관련
  btnAdminEntry: document.getElementById('btn-admin-entry'),
  btnAdminAdd: document.getElementById('btn-admin-add'),
  btnAdminExit: document.getElementById('btn-admin-exit'),
  adminQuestionList: document.getElementById('admin-question-list'),
  
  // 교사용 관리자 설정 요소
  inputQuizTime: document.getElementById('input-quiz-time'),
  inputQuizCount: document.getElementById('input-quiz-count'),
  chkTtsEnabled: document.getElementById('chk-tts-enabled'),
  
  // 문제 편집용 모달 관련
  modalQuestion: document.getElementById('modal-question'),
  formQuestion: document.getElementById('form-question'),
  formQuestionId: document.getElementById('form-question-id'),
  formQuestionText: document.getElementById('form-question-text'),
  formHint: document.getElementById('form-hint'),
  btnModalCancel: document.getElementById('btn-modal-cancel'),
  chkShowSkeleton: document.getElementById('chk-show-skeleton') // 관절 온오프 체크박스
};

// ==========================================
// 커스텀 모달 다이얼로그 시스템 (alert/confirm/prompt 대체용)
// ==========================================
const dialogEls = {
  modal: document.getElementById('custom-dialog-modal'),
  title: document.getElementById('dialog-title'),
  message: document.getElementById('dialog-message'),
  promptContainer: document.getElementById('dialog-prompt-container'),
  promptInput: document.getElementById('dialog-prompt-input'),
  btnCancel: document.getElementById('btn-dialog-cancel'),
  btnConfirm: document.getElementById('btn-dialog-confirm')
};

function customAlert(message, title = "알림 🌟") {
  return new Promise((resolve) => {
    dialogEls.title.textContent = title;
    dialogEls.message.innerHTML = message.replace(/\n/g, '<br>');
    dialogEls.promptContainer.style.display = 'none';
    dialogEls.btnCancel.style.display = 'none';
    dialogEls.btnConfirm.style.display = 'inline-block';
    dialogEls.modal.classList.add('active');
    
    const onConfirm = () => {
      dialogEls.modal.classList.remove('active');
      dialogEls.btnConfirm.removeEventListener('click', onConfirm);
      resolve();
    };
    dialogEls.btnConfirm.addEventListener('click', onConfirm);
  });
}

function customConfirm(message, title = "확인해 주세요 ❓") {
  return new Promise((resolve) => {
    dialogEls.title.textContent = title;
    dialogEls.message.innerHTML = message.replace(/\n/g, '<br>');
    dialogEls.promptContainer.style.display = 'none';
    dialogEls.btnCancel.style.display = 'inline-block';
    dialogEls.btnConfirm.style.display = 'inline-block';
    dialogEls.modal.classList.add('active');
    
    const cleanup = (value) => {
      dialogEls.modal.classList.remove('active');
      dialogEls.btnConfirm.removeEventListener('click', onConfirm);
      dialogEls.btnCancel.removeEventListener('click', onCancel);
      resolve(value);
    };
    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    
    dialogEls.btnConfirm.addEventListener('click', onConfirm);
    dialogEls.btnCancel.addEventListener('click', onCancel);
  });
}

function customPrompt(message, defaultValue = "", title = "비밀번호 입력 🔑") {
  return new Promise((resolve) => {
    dialogEls.title.textContent = title;
    dialogEls.message.innerHTML = message.replace(/\n/g, '<br>');
    dialogEls.promptContainer.style.display = 'block';
    dialogEls.promptInput.value = defaultValue;
    dialogEls.btnCancel.style.display = 'inline-block';
    dialogEls.btnConfirm.style.display = 'inline-block';
    dialogEls.modal.classList.add('active');
    setTimeout(() => dialogEls.promptInput.focus(), 100);
    
    const cleanup = (value) => {
      dialogEls.modal.classList.remove('active');
      dialogEls.btnConfirm.removeEventListener('click', onConfirm);
      dialogEls.btnCancel.removeEventListener('click', onCancel);
      resolve(value);
    };
    const onConfirm = () => cleanup(dialogEls.promptInput.value);
    const onCancel = () => cleanup(null);
    
    dialogEls.btnConfirm.addEventListener('click', onConfirm);
    dialogEls.btnCancel.addEventListener('click', onCancel);
  });
}

// 캔버스 2D 컨텍스트 설정
const pointerCtx = els.pointerCanvas.getContext('2d');
const cameraCtx = els.cameraOverlay.getContext('2d');

// 파티클 시스템 (요술봉 꼬리 효과)
const particles = [];

// ==========================================
// 1.5. LocalStorage 데이터 저장 및 로드
// ==========================================
function getQuestions() {
  const data = localStorage.getItem(STORAGE_KEY);
  if (!data) {
    // 없으면 기본 문제 저장 후 리턴
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultQuestions));
    return defaultQuestions;
  }
  return JSON.parse(data);
}

function saveQuestions(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

// [선생님 설정] 설정 데이터 로드 함수 (한글 주석 적용)
function loadSettings() {
  const savedLimitTime = localStorage.getItem(TIMER_LIMIT_KEY);
  if (savedLimitTime !== null) {
    state.limitTime = parseInt(savedLimitTime, 10);
  }
  
  const savedQuestionCount = localStorage.getItem(QUESTION_COUNT_KEY);
  if (savedQuestionCount !== null) {
    state.questionCount = parseInt(savedQuestionCount, 10);
  }
  
  const savedTtsEnabled = localStorage.getItem(TTS_ENABLED_KEY);
  if (savedTtsEnabled !== null) {
    state.ttsEnabled = savedTtsEnabled === 'true';
  }
  
  // UI 설정 화면에 값 동기화
  if (els.inputQuizTime) els.inputQuizTime.value = state.limitTime;
  if (els.inputQuizCount) els.inputQuizCount.value = state.questionCount;
  if (els.chkTtsEnabled) els.chkTtsEnabled.checked = state.ttsEnabled;
}

// [선생님 설정] 설정 데이터 저장 함수
function saveSettings() {
  localStorage.setItem(TIMER_LIMIT_KEY, state.limitTime);
  localStorage.setItem(QUESTION_COUNT_KEY, state.questionCount);
  localStorage.setItem(TTS_ENABLED_KEY, state.ttsEnabled);
}

// 앱 구동 즉시 설정 정보 로드 실행
loadSettings();

// ==========================================
// 2. Web Audio API 오디오 신디사이저 (어린이 맞춤 밝은 톤)
// ==========================================
let audioCtx = null;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  state.audioEnabled = true;
}

// 부드러운 실로폰/물방울 소리 생성기
function playTone(freq, duration, type = 'sine', slideTo = null) {
  if (!state.audioEnabled) return;
  
  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();
  
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  
  if (slideTo) {
    osc.frequency.exponentialRampToValueAtTime(slideTo, audioCtx.currentTime + duration);
  }
  
  // 소리가 부드럽게 감쇠하도록 이완 필터 적용 (아동 청각 보호)
  gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  
  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

// 오디오 사운드 세트
const sounds = {
  tick: () => playTone(600, 0.05, 'triangle'),
  select: () => playTone(300, 0.15, 'sine', 600),
  correct: () => {
    // 딩동댕~ 실로폰 화음
    const playNote = (f, delay) => {
      setTimeout(() => playTone(f, 0.4, 'sine'), delay);
    };
    playNote(523.25, 0);   // 도 (C5)
    playNote(659.25, 100); // 미 (E5)
    playNote(783.99, 200); // 솔 (G5)
    playNote(1046.50, 300); // 도 (C6)
  },
  incorrect: () => {
    // 뽀잉~ 또는 어라라? 하는 만화 느낌 하강음
    playTone(350, 0.35, 'triangle', 180);
  },
  cheer: () => {
    // 게임 완료 축하 팡파르
    const notes = [523.25, 587.33, 659.25, 698.46, 783.99, 880.00, 987.77, 1046.50];
    notes.forEach((f, i) => {
      setTimeout(() => playTone(f, 0.25, 'sine'), i * 80);
    });
  }
};

// ==========================================
// 2.5. TTS (음성 합성) 문제 읽어주기 기능 (한글 주석 적용)
// ==========================================
function speakQuestion(text) {
  if (!state.ttsEnabled) return;
  
  // 이모지 및 특수 그림 문자(유니코드 범위)를 제거하는 정규식 필터링 (한글 주석 적용)
  const cleanedText = text.replace(/[\u{1F300}-\u{1FAFF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F900}-\u{1F9FF}]/gu, '');

  // 현재 재생 중인 모든 음성을 중단하여 소리가 겹치는 현상 방지
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(cleanedText);
    utterance.lang = 'ko-KR';
    
    // 어린이 전용 커스텀 튜닝: 목소리 속도를 약간 늦추고(0.95), 톤을 조금 귀엽게 높임(1.15)
    utterance.rate = 0.95;
    utterance.pitch = 1.15;
    
    // 디바이스에 한글 TTS 보이스가 여러 개 탑재된 경우, 최적의 한국어 목소리를 찾아 매핑
    const voices = window.speechSynthesis.getVoices();
    const koreanVoice = voices.find(voice => voice.lang.includes('ko-KR') || voice.lang.includes('ko_KR'));
    if (koreanVoice) {
      utterance.voice = koreanVoice;
    }
    
    window.speechSynthesis.speak(utterance);
  }
}

// ==========================================
// 3. 화면 전환 및 이벤트 바인딩
// ==========================================
function changeScreen(screenId) {
  // 퀴즈 진행 중이 아닌 다른 화면으로 이탈 시, 살아있는 타이머들을 완전 박멸 (한글 주석 적용)
  if (screenId !== 'quiz') {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    if (state.feedbackTimeout) {
      clearTimeout(state.feedbackTimeout);
      state.feedbackTimeout = null;
    }
    // 피드백 팝업 오버레이 강제 제거
    if (els.feedbackOverlay) {
      els.feedbackOverlay.classList.remove('active');
    }
  }

  // 모든 화면 비활성화
  Object.keys(els.screens).forEach(key => {
    els.screens[key].classList.remove('active');
  });
  
  // 지정 화면 활성화
  els.screens[screenId].classList.add('active');
  state.screen = screenId;
  
  // 화면별 초기화 로직 및 배경 카메라 전체 화면 클래스 토글
  if (screenId === 'quiz') {
    document.body.classList.add('quiz-active');
    document.body.classList.remove('calibration-active');
    startQuiz();
  } else if (screenId === 'calibration') {
    document.body.classList.add('calibration-active');
    document.body.classList.remove('quiz-active');
  } else {
    document.body.classList.remove('quiz-active', 'calibration-active');
    if (screenId === 'result') {
      showResult();
    }
  }
}

// 이벤트 리스너 연결
// 퀴즈 진행 중 나가기 버튼 바인딩
if (els.btnQuizExit) {
  els.btnQuizExit.addEventListener('click', async () => {
    const confirmExit = await customConfirm("정말로 퀴즈를 중단하고 홈으로 돌아갈까요?");
    if (confirmExit) {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      stopWebcam();
      changeScreen('home');
    }
  });
}

els.btnStart.addEventListener('click', () => {
  initAudio();
  changeScreen('calibration');
  initWebcam();
});

els.btnCalBack.addEventListener('click', () => {
  stopWebcam();
  changeScreen('home');
});

els.btnCalReady.addEventListener('click', () => {
  if (state.isCalibrated) {
    changeScreen('quiz');
  }
});

els.btnRestart.addEventListener('click', () => {
  changeScreen('calibration');
  initWebcam();
});

// 창 크기 조절 시 캔버스 스케일 재조정
function resizeCanvases() {
  els.pointerCanvas.width = window.innerWidth;
  els.pointerCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvases);
resizeCanvases();

// 관절 스켈레톤 온오프 설정 동기화
const SKELETON_STORAGE_KEY = 'ox_quiz_show_skeleton';
const savedShowSkeleton = localStorage.getItem(SKELETON_STORAGE_KEY);
if (savedShowSkeleton !== null) {
  state.showSkeleton = savedShowSkeleton === 'true';
}
if (els.chkShowSkeleton) {
  els.chkShowSkeleton.checked = state.showSkeleton;
  els.chkShowSkeleton.addEventListener('change', (e) => {
    state.showSkeleton = e.target.checked;
    localStorage.setItem(SKELETON_STORAGE_KEY, e.target.checked);
  });
}

// ==========================================
// 3.5. 교사용 문제 관리 기능 (CRUD) 이벤트 바인딩
// ==========================================

// 교사 관리자 페이지 입장
els.btnAdminEntry.addEventListener('click', async () => {
  const pin = await customPrompt("선생님 방 열쇠 🔑 비밀번호를 입력해 주세요.\n(기본 비밀번호: 1234)");
  if (pin === '1234') {
    stopWebcam(); // 설정 중일 때는 불필요한 카메라 트래킹 정지
    changeScreen('admin');
    renderAdminTable();
  } else if (pin !== null) {
    await customAlert("비밀번호가 맞지 않아요! 다시 입력해 주세요.", "오류 ❌");
  }
});

// 교사 페이지 퇴장
els.btnAdminExit.addEventListener('click', () => {
  saveSettings();
  changeScreen('home');
});

// [선생님 설정] 설정 변경 감지 및 저장 이벤트 바인딩 (한글 주석 적용)
if (els.inputQuizTime) {
  els.inputQuizTime.addEventListener('input', (e) => {
    let val = parseInt(e.target.value, 10);
    if (!isNaN(val)) {
      // 5초보다 작으면 강제로 5초로 최소값 보정
      if (val < 5) val = 5;
      state.limitTime = val;
      saveSettings();
    }
  });
}

if (els.inputQuizCount) {
  els.inputQuizCount.addEventListener('input', (e) => {
    let val = parseInt(e.target.value, 10);
    if (!isNaN(val)) {
      // 최소 1문제 이상 보정
      if (val < 1) val = 1;
      state.questionCount = val;
      saveSettings();
    }
  });
}

if (els.chkTtsEnabled) {
  els.chkTtsEnabled.addEventListener('change', (e) => {
    state.ttsEnabled = e.target.checked;
    saveSettings();
  });
}

// 새 문제 모달 열기
els.btnAdminAdd.addEventListener('click', () => {
  openModal();
});

// 전체 선택 체크박스 동작 바인딩
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'chk-select-all') {
    const checkboxes = document.querySelectorAll('.chk-question-item');
    checkboxes.forEach(cb => cb.checked = e.target.checked);
  }
});

// 선택 삭제 (일괄 삭제) 이벤트 리스너 연결
const btnBulkDelete = document.getElementById('btn-admin-bulk-delete');
if (btnBulkDelete) {
  btnBulkDelete.addEventListener('click', async () => {
    const selectedCheckboxes = document.querySelectorAll('.chk-question-item:checked');
    if (selectedCheckboxes.length === 0) {
      await customAlert("삭제할 문제를 선택해 주세요!", "알림 ⚠️");
      return;
    }
    
    const confirmDel = await customConfirm(`선택한 ${selectedCheckboxes.length}개의 문제를 삭제하시겠습니까?`);
    if (confirmDel) {
      const idsToDelete = Array.from(selectedCheckboxes).map(cb => parseInt(cb.dataset.id));
      let list = getQuestions();
      list = list.filter(q => !idsToDelete.includes(q.id));
      saveQuestions(list);
      
      // 전체 선택 상태 해제
      const chkSelectAll = document.getElementById('chk-select-all');
      if (chkSelectAll) chkSelectAll.checked = false;
      
      renderAdminTable();
      await customAlert("선택한 문제를 일괄 삭제했습니다. 🗑️", "삭제 완료 🎉");
    }
  });
}

// 모달 취소
els.btnModalCancel.addEventListener('click', closeModal);

// 모달 저장 (추가/수정)
els.formQuestion.addEventListener('submit', (e) => {
  e.preventDefault();
  saveQuestionForm();
});

// ==========================================
// 3.6. 교사용 CRUD 핵심 함수
// ==========================================

// 문제 목록 테이블 렌더링
function renderAdminTable() {
  const list = getQuestions();
  els.adminQuestionList.innerHTML = '';
  
  if (list.length === 0) {
    els.adminQuestionList.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #999; padding: 20px;">등록된 문제가 없습니다. 문제를 추가해 주세요!</td></tr>`;
    return;
  }
  
  list.forEach(q => {
    const tr = document.createElement('tr');
    
    // O/X 배지 색상 결정
    const badgeClass = q.answer === 'O' ? 'badge-o' : 'badge-x';
    
    tr.innerHTML = `
      <td style="text-align: center;">
        <input type="checkbox" class="chk-question-item" data-id="${q.id}">
      </td>
      <td>
        <div style="font-weight: bold; font-size: 1.2rem;">${q.question}</div>
        <div style="font-size: 0.95rem; color: #777; margin-top: 4px;">💡 정답 해설: ${q.hint}</div>
      </td>
      <td style="text-align: center;"><span class="${badgeClass}">${q.answer}</span></td>
      <td>
        <button class="btn-table-action btn-edit" data-id="${q.id}">수정</button>
        <button class="btn-table-action btn-delete" data-id="${q.id}">삭제</button>
      </td>
    `;
    
    // 버튼 이벤트 직접 연결
    tr.querySelector('.btn-edit').addEventListener('click', () => openModal(q.id));
    tr.querySelector('.btn-delete').addEventListener('click', () => deleteQuestion(q.id));
    
    els.adminQuestionList.appendChild(tr);
  });
}

// 모달 활성화
function openModal(id = null) {
  els.modalQuestion.classList.add('active');
  els.formQuestion.reset();
  
  if (id) {
    // 수정 모드
    document.getElementById('modal-title').textContent = "퀴즈 문제 수정하기 ✏️";
    const list = getQuestions();
    const q = list.find(item => item.id === id);
    if (q) {
      els.formQuestionId.value = q.id;
      els.formQuestionText.value = q.question;
      els.formHint.value = q.hint;
      
      // 라디오 버튼 선택 처리
      const radios = document.getElementsByName('form-answer');
      for (let r of radios) {
        if (r.value === q.answer) r.checked = true;
      }
    }
  } else {
    // 신규 추가 모드
    document.getElementById('modal-title').textContent = "새 문제 등록하기 ➕";
    els.formQuestionId.value = '';
  }
}

// 모달 닫기
function closeModal() {
  els.modalQuestion.classList.remove('active');
}

// 문제 추가/수정 데이터 처리
function saveQuestionForm() {
  const idVal = els.formQuestionId.value;
  const questionVal = els.formQuestionText.value.trim();
  const hintVal = els.formHint.value.trim();
  
  // 정답 값 파싱
  const radios = document.getElementsByName('form-answer');
  let answerVal = 'O';
  for (let r of radios) {
    if (r.checked) answerVal = r.value;
  }
  
  let list = getQuestions();
  
  if (idVal) {
    // 수정 모드
    const targetId = parseInt(idVal);
    const index = list.findIndex(item => item.id === targetId);
    if (index !== -1) {
      list[index] = {
        id: targetId,
        question: questionVal,
        answer: answerVal,
        hint: hintVal
      };
    }
  } else {
    // 신규 등록 모드
    const newQuestion = {
      id: Date.now(), // 유니크 아이디 생성
      question: questionVal,
      answer: answerVal,
      hint: hintVal
    };
    list.push(newQuestion);
  }
  
  saveQuestions(list);
  closeModal();
  renderAdminTable();
}

// 문제 단건 삭제
async function deleteQuestion(id) {
  const confirmDel = await customConfirm("정말로 이 문제를 삭제하시겠습니까?");
  if (confirmDel) {
    let list = getQuestions();
    list = list.filter(item => item.id !== id);
    saveQuestions(list);
    renderAdminTable();
  }
}

// ==========================================
// 4. 카메라 및 MediaPipe Pose 세팅
// ==========================================
async function initWebcam() {
  els.cameraLoading.style.display = 'flex';
  els.btnCalReady.classList.add('disabled');
  els.btnCalReady.disabled = true;
  state.isCalibrated = false;
  
  try {
    // 1. 카메라 스트림 획득
    state.webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false
    });
    els.webcam.srcObject = state.webcamStream;
    
    // 비디오 크기에 맞게 내부 보정용 캔버스 크기 맞추기
    els.webcam.onloadedmetadata = () => {
      els.cameraOverlay.width = 640;
      els.cameraOverlay.height = 480;
    };
    
    // 2. MediaPipe Pose Landmarker 초기화 (지연 로딩 방지)
    if (!state.poseLandmarker) {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.8/wasm"
      );
      state.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task"
        },
        runningMode: "VIDEO",
        outputSegmentationMasks: false
      });
    }
    
    els.cameraLoading.style.display = 'none';
    state.isTrackingReady = true;
    
    // 인식 루프 시작
    requestAnimationFrame(updateLoop);
    
  } catch (error) {
    console.error("카메라를 켤 수 없습니다:", error);
    await customAlert("카메라 연결을 확인할 수 없습니다. 브라우저의 카메라 권한 설정을 확인해 주세요!", "오류 ❌");
    changeScreen('home');
  }
}

function stopWebcam() {
  if (state.webcamStream) {
    state.webcamStream.getTracks().forEach(track => track.stop());
    state.webcamStream = null;
  }
  state.isTrackingReady = false;
}

// ==========================================
// 5. 실시간 동작 감지 및 핵심 게임 루프
// ==========================================
let lastVideoTime = -1;

function updateLoop(timestamp) {
  if (!state.isTrackingReady) return;
  
  const now = performance.now();
  const deltaTime = now - state.lastFrameTime;
  state.lastFrameTime = now;
  
  // 1. 동작 인식 (MediaPipe Pose)
  if (els.webcam.currentTime !== lastVideoTime) {
    lastVideoTime = els.webcam.currentTime;
    
    if (state.poseLandmarker) {
      const results = state.poseLandmarker.detectForVideo(els.webcam, timestamp);
      processPoseResults(results);
    }
  }
  
  // 2. 물리 엔진: 손끝 좌표 보간(Smoothing) 적용 및 파티클 관리
  updatePointerPhysics();
  
  // 3. UI 그리기
  drawPointerCanvas();
  drawCameraOverlay();
  
  // 4. 게임 모드에서의 선택 충돌 체크 (Dwell Time 계산)
  if (state.screen === 'quiz') {
    checkDwellSelection(deltaTime);
  }
  
  requestAnimationFrame(updateLoop);
}

// 포즈 데이터 가공 및 제스처 맵핑
function processPoseResults(results) {
  if (results && results.landmarks && results.landmarks.length > 0) {
    const landmarks = results.landmarks[0];
    state.currentLandmarks = landmarks; // 실시간 랜드마크 갱신 저장
    
    // 주요 키포인트 획득
    const nose = landmarks[0];
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    const leftWrist = landmarks[15];
    const rightWrist = landmarks[16];
    
    // 머리와 어깨 감지 여부
    if (nose && leftShoulder && rightShoulder) {
      // 카메라 보정 성공 상태 업데이트
      if (state.screen === 'calibration' && !state.isCalibrated) {
        state.isCalibrated = true;
        els.trackingStatus.textContent = "어린이 감지 성공! 준비 완료 버튼을 눌러요 🎈";
        els.trackingStatus.className = "status-badge status-ready";
        els.btnCalReady.classList.remove('disabled');
        els.btnCalReady.disabled = false;
      }
      
      // 손 추적 활성화 판단
      // 손목의 Y 위치가 어깨 Y 위치보다 올라갔거나, 최소한 가슴(배꼽) 높이 이상일 때 포인터 활성화
      const leftActive = leftWrist && leftWrist.visibility > 0.5 && leftWrist.y < 0.65;
      const rightActive = rightWrist && rightWrist.visibility > 0.5 && rightWrist.y < 0.65;
      
      if (leftActive || rightActive) {
        state.isHandActive = true;
        
        // 더 높이 들고 있는 손을 타겟으로 설정 (Y값이 더 작을수록 높은 위치)
        let activeHand = null;
        if (leftActive && rightActive) {
          activeHand = (leftWrist.y < rightWrist.y) ? leftWrist : rightWrist;
        } else {
          activeHand = leftActive ? leftWrist : rightWrist;
        }
        
        // 민감도 조정(Virtual Trackpad): 중앙 0.3~0.7 영역을 전체 화면 크기로 확장 맵핑
        // 카메라 가로 미러링(1 - x)을 반영하여 스크린 X축 맞춤
        const minX = 0.25;
        const maxX = 0.75;
        const minY = 0.2;
        const maxY = 0.6;
        
        // 가로축 맵핑
        let targetX = (1 - activeHand.x);
        targetX = (targetX - minX) / (maxX - minX);
        targetX = Math.max(0, Math.min(1, targetX)) * window.innerWidth;
        
        // 세로축 맵핑
        let targetY = (activeHand.y - minY) / (maxY - minY);
        targetY = Math.max(0, Math.min(1, targetY)) * window.innerHeight;
        
        state.targetPointer.x = targetX;
        state.targetPointer.y = targetY;
        
      } else {
        // 손이 감지 범위 밖일 때 포인터 숨김
        state.isHandActive = false;
      }
    }
  } else {
    // 아무도 감지되지 않음
    state.currentLandmarks = null; // 랜드마크 데이터 제거
    if (state.screen === 'calibration' && state.isCalibrated) {
      state.isCalibrated = false;
      els.trackingStatus.textContent = "움직임을 기다리는 중... ⏳";
      els.trackingStatus.className = "status-badge status-waiting";
      els.btnCalReady.classList.add('disabled');
      els.btnCalReady.disabled = true;
    }
    state.isHandActive = false;
  }
}

// ==========================================
// 6. 물리 연산 및 비주얼 이펙트 (요술봉 파티클)
// ==========================================
function updatePointerPhysics() {
  if (state.isHandActive) {
    // 꼬리 흔들림 보정을 위한 부드러운 선형 보간 (Lerp)
    state.pointer.x += (state.targetPointer.x - state.pointer.x) * 0.22;
    state.pointer.y += (state.targetPointer.y - state.pointer.y) * 0.22;
    
    // 매 프레임별 요술봉 별빛 파티클 생성
    if (Math.random() < 0.4) {
      particles.push({
        x: state.pointer.x,
        y: state.pointer.y,
        vx: (Math.random() - 0.5) * 3,
        vy: (Math.random() - 0.5) * 3 - 1, // 위로 향하는 경향
        size: Math.random() * 12 + 8,
        color: `hsl(${Math.random() * 360}, 100%, 75%)`, // 알록달록 무지개 파스텔
        alpha: 1,
        life: 1.0
      });
    }
  }
  
  // 파티클 상태 업데이트 및 소멸 처리
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.alpha -= 0.03;
    p.size *= 0.95;
    
    if (p.alpha <= 0 || p.size < 2) {
      particles.splice(i, 1);
    }
  }
}

// 전체 화면 포인터 및 요술봉 꼬리 그리기 (별 캐릭터 삭제 처리)
function drawPointerCanvas() {
  pointerCtx.clearRect(0, 0, els.pointerCanvas.width, els.pointerCanvas.height);
}

// 보정 가이드라인 및 관절 스켈레톤, 손끝 조준점 그리기 (복구됨)
function drawCameraOverlay() {
  cameraCtx.clearRect(0, 0, 640, 480);
  
  if (!state.isTrackingReady || !state.currentLandmarks) return;
  
  const landmarks = state.currentLandmarks;
  
  // 1. 관절 연결선 그리기 (뼈대 선) - 설정이 켜져 있을 때만
  if (state.showSkeleton) {
    cameraCtx.save();
    cameraCtx.strokeStyle = "rgba(46, 196, 182, 0.9)"; // 귀여운 민트색 형광선
    cameraCtx.lineWidth = 6;
    cameraCtx.lineCap = "round";
    cameraCtx.lineJoin = "round";
    
    POSE_CONNECTIONS.forEach(([i1, i2]) => {
      const pt1 = landmarks[i1];
      const pt2 = landmarks[i2];
      
      // 인지 정확도(visibility)가 50% 이상일 때만 스켈레톤 선을 연결
      if (pt1 && pt2 && pt1.visibility > 0.5 && pt2.visibility > 0.5) {
        cameraCtx.beginPath();
        cameraCtx.moveTo(pt1.x * 640, pt1.y * 480);
        cameraCtx.lineTo(pt2.x * 640, pt2.y * 480);
        cameraCtx.stroke();
      }
    });
    cameraCtx.restore();
    
    // 2. 주요 골격 노드(관절 포인트) 원형 마크 그리기
    const keyJoints = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]; // 시각화할 핵심 관절들
    
    cameraCtx.save();
    keyJoints.forEach(index => {
      const pt = landmarks[index];
      if (pt && pt.visibility > 0.5) {
        // 흰색 외곽선 원
        cameraCtx.fillStyle = "#ffffff";
        cameraCtx.beginPath();
        cameraCtx.arc(pt.x * 640, pt.y * 480, 8, 0, Math.PI * 2);
        cameraCtx.fill();
        
        // 내부 핑크색 원 포인트
        cameraCtx.fillStyle = "#ff769f";
        cameraCtx.beginPath();
        cameraCtx.arc(pt.x * 640, pt.y * 480, 5, 0, Math.PI * 2);
        cameraCtx.fill();
      }
    });
    cameraCtx.restore();
  }
  
  // 3. 손끝(양손 검지 19, 20번) 위치에 실시간 터치 마커 도트 렌더링 (동작 인지 가독성 향상)
  const leftIndex = landmarks[19];
  const rightIndex = landmarks[20];
  
  cameraCtx.save();
  cameraCtx.fillStyle = "rgba(46, 196, 182, 0.9)"; // 형광 민트색 포인터
  cameraCtx.strokeStyle = "#ffffff";
  cameraCtx.lineWidth = 3;
  
  [leftIndex, rightIndex].forEach(pt => {
    if (pt && pt.visibility > 0.5) {
      cameraCtx.beginPath();
      cameraCtx.arc(pt.x * 640, pt.y * 480, 10, 0, Math.PI * 2);
      cameraCtx.fill();
      cameraCtx.stroke();
    }
  });
  cameraCtx.restore();
}

// ==========================================
// 7. 충돌 판정 및 Dwell Time 선택 기능 (양손 검지 손가락 끝 다이렉트 터치형)
// ==========================================
function checkDwellSelection(deltaTime) {
  // 양손 검지 손가락 끝의 스크린 좌표 획득
  let hands = [];
  if (state.currentLandmarks) {
    const leftIndex = state.currentLandmarks[19]; // 왼쪽 검지 손가락 끝 랜드마크
    const rightIndex = state.currentLandmarks[20]; // 오른쪽 검지 손가락 끝 랜드마크
    
    // 왼손이 감지될 경우 스크린 크기로 좌표 맵핑 (가로 미러링 반영)
    if (leftIndex && leftIndex.visibility > 0.5) {
      hands.push({
        x: (1 - leftIndex.x) * window.innerWidth,
        y: leftIndex.y * window.innerHeight
      });
    }
    // 오른손이 감지될 경우 스크린 크기로 좌표 맵핑 (가로 미러링 반영)
    if (rightIndex && rightIndex.visibility > 0.5) {
      hands.push({
        x: (1 - rightIndex.x) * window.innerWidth,
        y: rightIndex.y * window.innerHeight
      });
    }
  }
  
  if (hands.length === 0) {
    resetDwell();
    return;
  }
  
  // O 구역, X 구역의 DOM 위치 정보 획득
  const rectO = els.zoneO.getBoundingClientRect();
  const rectX = els.zoneX.getBoundingClientRect();
  
  let hitO = false;
  let hitX = false;
  
  // 양손 중 어떤 한 손이라도 선택 영역에 들어왔는지 전수 조사
  hands.forEach(hand => {
    const px = hand.x;
    const py = hand.y;
    
    // O 영역 내 진입 여부
    if (px >= rectO.left && px <= rectO.right && py >= rectO.top && py <= rectO.bottom) {
      hitO = true;
    }
    // X 영역 내 진입 여부
    if (px >= rectX.left && px <= rectX.right && py >= rectX.top && py <= rectX.bottom) {
      hitX = true;
    }
  });
  
  // O 과녁 충돌 처리
  if (hitO) {
    state.dwellO += deltaTime;
    state.dwellX = 0;
    
    els.oBtn.classList.add('hovered');
    els.xBtn.classList.remove('hovered');
    
    const pct = Math.min(state.dwellO / state.targetDwellTime, 1);
    updateDwellRing(els.dwellOProgress, pct);
    updateDwellRing(els.dwellXProgress, 0);
    
    // 차징음 틱소리
    if (state.dwellO > 100 && Math.floor(state.dwellO / 150) > Math.floor((state.dwellO - deltaTime) / 150)) {
      sounds.tick();
    }
    
    if (state.dwellO >= state.targetDwellTime) {
      triggerAnswer('O');
      resetDwell();
    }
  } 
  // X 과녁 충돌 처리
  else if (hitX) {
    state.dwellX += deltaTime;
    state.dwellO = 0;
    
    els.xBtn.classList.add('hovered');
    els.oBtn.classList.remove('hovered');
    
    const pct = Math.min(state.dwellX / state.targetDwellTime, 1);
    updateDwellRing(els.dwellXProgress, pct);
    updateDwellRing(els.dwellOProgress, 0);
    
    if (state.dwellX > 100 && Math.floor(state.dwellX / 150) > Math.floor((state.dwellX - deltaTime) / 150)) {
      sounds.tick();
    }
    
    if (state.dwellX >= state.targetDwellTime) {
      triggerAnswer('X');
      resetDwell();
    }
  } 
  // 영역 바깥
  else {
    resetDwell();
  }
}



function resetDwell() {
  state.dwellO = 0;
  state.dwellX = 0;
  els.oBtn.classList.remove('hovered');
  els.xBtn.classList.remove('hovered');
  updateDwellRing(els.dwellOProgress, 0);
  updateDwellRing(els.dwellXProgress, 0);
}

// SVG 원형 프로그레스 바 대시 오프셋 업데이트
function updateDwellRing(element, percent) {
  const radius = 50;
  const circumference = 2 * Math.PI * radius; // 약 314.16
  const offset = circumference - (percent * circumference);
  element.style.strokeDashoffset = offset;
}

// ==========================================
// 8. 퀴즈 게임 오작동 방지 및 생명주기 제어
// ==========================================
function startQuiz() {
  state.currentQuestionIndex = 0;
  state.score = 0;
  
  // LocalStorage로부터 데이터 로드
  const allQuestions = getQuestions();
  
  // 현재 설정된 목표 문제 수보다 등록된 전체 문제 수가 적으면 예외 알림
  if (allQuestions.length < state.questionCount) {
    alert(`출제할 수 있는 문제가 부족해요! 😭\n선생님 방에서 문제를 최소 ${state.questionCount}개 이상 등록하거나 출제 문제 수를 낮춰주세요.`);
    changeScreen('home');
    stopWebcam();
    return;
  }
  
  // 문제를 무작위로 셔플 후 선생님이 지정한 개수만큼 잘라서 게임 리스트에 넣음 (한글 주석 적용)
  state.questions = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, state.questionCount);
  
  els.totalQuestionsNum.textContent = state.questions.length;
  showQuestion(state.currentQuestionIndex);
}

function showQuestion(index) {
  const q = state.questions[index];
  
  // 텍스트 바인딩
  els.currentQuestionNum.textContent = index + 1;
  els.questionText.textContent = q.question;
  els.scoreStars.textContent = `⭐ ${state.score}`;
  
  // 게이지 초기화
  resetDwell();
  
  // 선생님 설정값인 limitTime으로 타이머 세팅 (15초 하드코딩 제거)
  state.timer = state.limitTime;
  els.timerText.textContent = state.timer;
  els.timerBar.style.width = '100%';
  
  // 문제 출제와 동시에 어린이들에게 음성으로 또박또박 문제 읽어주기 (TTS)
  speakQuestion(q.question);
  
  if (state.timerInterval) clearInterval(state.timerInterval);
  
  state.timerInterval = setInterval(() => {
    state.timer--;
    els.timerText.textContent = state.timer;
    els.timerBar.style.width = `${(state.timer / state.limitTime) * 100}%`;
    
    // 시간 만료 시
    if (state.timer <= 0) {
      clearInterval(state.timerInterval);
      triggerTimeOut();
    } else if (state.timer <= 3) {
      // 3초 남았을 때 째깍째깍 알림음
      sounds.tick();
    }
  }, 1000);
}

// 정답 처리 실행
function triggerAnswer(selectedOption) {
  clearInterval(state.timerInterval);
  sounds.select();
  
  const q = state.questions[state.currentQuestionIndex];
  const isCorrect = q.answer === selectedOption;
  
  if (isCorrect) {
    state.score++;
  }
  
  showFeedback(isCorrect, q);
}

// 시간 만료 처리
function triggerTimeOut() {
  const q = state.questions[state.currentQuestionIndex];
  showFeedback(false, q, true);
}

// 정답 피드백 팝업 보여주기
function showFeedback(isCorrect, questionObj, isTimeout = false) {
  // 상태 클래스 초기화
  els.feedbackOverlay.className = 'feedback-overlay';
  
  if (isCorrect) {
    els.feedbackOverlay.classList.add('correct', 'active');
    els.feedbackSymbol.textContent = '⭕';
    els.feedbackTitle.textContent = '딩동댕! 정말 잘했어요! 🎉';
    els.feedbackDesc.textContent = `맞았어요! ${questionObj.hint}`;
    sounds.correct();
  } else {
    els.feedbackOverlay.classList.add('incorrect', 'active');
    els.feedbackSymbol.textContent = '❌';
    els.feedbackTitle.textContent = isTimeout ? '째깍째깍 시간 초과! ⏰' : '아쉬워요! 다음 문제에서 맞춰봐요!';
    els.feedbackDesc.textContent = `정답은 "${questionObj.answer}" 이에요! \n ${questionObj.hint}`;
    sounds.incorrect();
  }
  
  // 3.5초 대기 후 다음 문제로 자동 전환
  state.feedbackTimeout = setTimeout(() => {
    els.feedbackOverlay.classList.remove('active');
    state.currentQuestionIndex++;
    
    if (state.currentQuestionIndex < state.questions.length) {
      showQuestion(state.currentQuestionIndex);
    } else {
      changeScreen('result');
    }
  }, 3800);
}

// ==========================================
// 9. 결과 집계 및 세레머니
// ==========================================
function showResult() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  stopWebcam();
  sounds.cheer();
  
  const total = state.questions.length;
  els.finalCorrectCount.textContent = state.score;
  els.finalTotalCount.textContent = total;
  
  // 별 개수 연출 및 등급 피드백
  let starsHtml = '';
  let msg = '';
  let trophy = '🏆';
  
  const scoreRatio = state.score / total;
  
  if (scoreRatio === 1) {
    starsHtml = '⭐⭐⭐⭐⭐';
    msg = '우와! 모든 퀴즈를 맞췄어요! 최고의 퀴즈 왕 탄생! 👑';
    trophy = '👑';
  } else if (scoreRatio >= 0.8) {
    starsHtml = '⭐⭐⭐⭐';
    msg = '대단해요! 다음번엔 만점에 도전해봐요! 🌟';
    trophy = '🏆';
  } else if (scoreRatio >= 0.5) {
    starsHtml = '⭐⭐⭐';
    msg = '참 잘했어요! 조금만 더 하면 만점이에요! 👍';
    trophy = '🏅';
  } else {
    starsHtml = '⭐⭐';
    msg = '친구, 정말 멋진 도전이었어요! 한 번 더 해볼까요? 💪';
    trophy = '🎈';
  }
  
  els.finalStarsContainer.textContent = starsHtml;
  els.resultMessage.textContent = msg;
  els.resultTrophyEmoji.textContent = trophy;
}
