import { questions as defaultQuestions } from './questions.js';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

// LocalStorage 키
const STORAGE_KEY = 'ox_quiz_questions';

// ==========================================
// 1. 전역 상태 및 DOM 요소 초기화
// ==========================================
const state = {
  screen: 'home',
  currentQuestionIndex: 0,
  score: 0,
  timer: 15,
  timerInterval: null,
  questions: [], // 실제 플레이할 무작위 5문항 리스트
  
  // 카메라 및 동작 인식 상태
  webcamStream: null,
  poseLandmarker: null,
  isTrackingReady: false,
  isCalibrated: false,
  
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
  questionEmoji: document.getElementById('question-emoji'),
  questionText: document.getElementById('question-text'),
  hintText: document.getElementById('hint-text'),
  
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
  btnAdminReset: document.getElementById('btn-admin-reset'),
  btnAdminExit: document.getElementById('btn-admin-exit'),
  adminQuestionList: document.getElementById('admin-question-list'),
  
  // 문제 편집용 모달 관련
  modalQuestion: document.getElementById('modal-question'),
  formQuestion: document.getElementById('form-question'),
  formQuestionId: document.getElementById('form-question-id'),
  formEmoji: document.getElementById('form-emoji'),
  formQuestionText: document.getElementById('form-question-text'),
  formHint: document.getElementById('form-hint'),
  btnModalCancel: document.getElementById('btn-modal-cancel')
};

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
// 3. 화면 전환 및 이벤트 바인딩
// ==========================================
function changeScreen(screenId) {
  // 모든 화면 비활성화
  Object.keys(els.screens).forEach(key => {
    els.screens[key].classList.remove('active');
  });
  
  // 지정 화면 활성화
  els.screens[screenId].classList.add('active');
  state.screen = screenId;
  
  // 화면별 초기화 로직
  if (screenId === 'quiz') {
    startQuiz();
  } else if (screenId === 'result') {
    showResult();
  }
}

// 이벤트 리스너 연결
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

// ==========================================
// 3.5. 교사용 문제 관리 기능 (CRUD) 이벤트 바인딩
// ==========================================

// 교사 관리자 페이지 입장
els.btnAdminEntry.addEventListener('click', () => {
  const pin = prompt("선생님 방 열쇠 🔑 비밀번호를 입력해 주세요.\n(기본 비밀번호: 1234)");
  if (pin === '1234') {
    stopWebcam(); // 설정 중일 때는 불필요한 카메라 트래킹 정지
    changeScreen('admin');
    renderAdminTable();
  } else if (pin !== null) {
    alert("비밀번호가 맞지 않아요! 다시 입력해 주세요.");
  }
});

// 교사 페이지 퇴장
els.btnAdminExit.addEventListener('click', () => {
  changeScreen('home');
});

// 새 문제 모달 열기
els.btnAdminAdd.addEventListener('click', () => {
  openModal();
});

// 문제 초기화 (기본 세팅 복원)
els.btnAdminReset.addEventListener('click', () => {
  if (confirm("정말로 모든 문제를 처음 문제 보관함 상태로 되돌릴까요?\n선생님이 직접 추가하신 문항들은 사라지게 됩니다.")) {
    saveQuestions(defaultQuestions);
    renderAdminTable();
    alert("처음 상태로 되돌려졌습니다! 🔄");
  }
});

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
      <td class="table-emoji">${q.emoji}</td>
      <td>
        <div style="font-weight: bold; font-size: 1.2rem;">${q.question}</div>
        <div style="font-size: 0.95rem; color: #777; margin-top: 4px;">💡 힌트: ${q.hint}</div>
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
      els.formEmoji.value = q.emoji;
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
  const emojiVal = els.formEmoji.value.trim() || "❓";
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
        hint: hintVal,
        emoji: emojiVal
      };
    }
  } else {
    // 신규 등록 모드
    const newQuestion = {
      id: Date.now(), // 유니크 아이디 생성
      question: questionVal,
      answer: answerVal,
      hint: hintVal,
      emoji: emojiVal
    };
    list.push(newQuestion);
  }
  
  saveQuestions(list);
  closeModal();
  renderAdminTable();
}

// 문제 단건 삭제
function deleteQuestion(id) {
  if (confirm("정말로 이 문제를 삭제하시겠습니까?")) {
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
    alert("카메라 연결을 확인할 수 없습니다. 브라우저의 카메라 권한 설정을 확인해 주세요!");
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

// 전체 화면 포인터 및 요술봉 꼬리 그리기
function drawPointerCanvas() {
  pointerCtx.clearRect(0, 0, els.pointerCanvas.width, els.pointerCanvas.height);
  
  // 1. 파티클 그리기
  particles.forEach(p => {
    pointerCtx.save();
    pointerCtx.globalAlpha = p.alpha;
    pointerCtx.fillStyle = p.color;
    drawStar(pointerCtx, p.x, p.y, 5, p.size, p.size / 2);
    pointerCtx.restore();
  });
  
  // 2. 활성화된 요술봉 머리 그리기 (별 캐릭터 또는 요술봉 모양)
  if (state.isHandActive) {
    pointerCtx.save();
    // 별 외곽선 네온 효과
    pointerCtx.shadowBlur = 20;
    pointerCtx.shadowColor = "#ffeb3b";
    pointerCtx.fillStyle = "#ffea79"; // 예쁜 옐로우 별
    pointerCtx.strokeStyle = "#fff";
    pointerCtx.lineWidth = 3;
    
    // 메인 요술봉 별 헤드 그리기
    drawStar(pointerCtx, state.pointer.x, state.pointer.y, 5, 25, 11);
    
    // 별 얼굴 그려주기 (유아 타겟 친근성 극대화!)
    pointerCtx.fillStyle = "#333";
    pointerCtx.beginPath();
    // 왼쪽 눈
    pointerCtx.arc(state.pointer.x - 5, state.pointer.y - 2, 2.5, 0, Math.PI * 2);
    // 오른쪽 눈
    pointerCtx.arc(state.pointer.x + 5, state.pointer.y - 2, 2.5, 0, Math.PI * 2);
    pointerCtx.fill();
    
    // 웃는 입
    pointerCtx.strokeStyle = "#333";
    pointerCtx.lineWidth = 1.5;
    pointerCtx.beginPath();
    pointerCtx.arc(state.pointer.x, state.pointer.y + 4, 4, 0, Math.PI);
    pointerCtx.stroke();
    
    pointerCtx.restore();
  }
}

// 별 형태를 그리는 헬퍼 함수
function drawStar(ctx, cx, cy, spikes, outerRadius, innerRadius) {
  let rot = Math.PI / 2 * 3;
  let x = cx;
  let y = cy;
  let step = Math.PI / spikes;

  ctx.beginPath();
  ctx.moveTo(cx, cy - outerRadius);
  for (let i = 0; i < spikes; i++) {
    x = cx + Math.cos(rot) * outerRadius;
    y = cy + Math.sin(rot) * outerRadius;
    ctx.lineTo(x, y);
    rot += step;

    x = cx + Math.cos(rot) * innerRadius;
    y = cy + Math.sin(rot) * innerRadius;
    ctx.lineTo(x, y);
    rot += step;
  }
  ctx.lineTo(cx, cy - outerRadius);
  ctx.closePath();
  ctx.fill();
  if (ctx.strokeStyle !== "rgba(0, 0, 0, 0)") {
    ctx.stroke();
  }
}

// TV 프레임 안쪽 작은 오버레이에 가이드라인 및 인식 표시
function drawCameraOverlay() {
  cameraCtx.clearRect(0, 0, 640, 480);
  // 스켈레톤 대신, 사용자가 본인이 잘 추적되고 있는지 귀엽게 보여주기 위해 얼굴/손 부위에만 파스텔톤 동그라미 표시
  if (state.isCalibrated && state.isHandActive) {
    // 캔버스 중앙에 요술봉 트래킹 중임을 텍스트로 작게 표시
    cameraCtx.save();
    cameraCtx.fillStyle = "rgba(46, 196, 182, 0.7)";
    cameraCtx.beginPath();
    // 손 트래킹 지점에 귀여운 마크
    const rawX = state.targetPointer.x / window.innerWidth * 640;
    const rawY = state.targetPointer.y / window.innerHeight * 480;
    cameraCtx.arc(rawX, rawY, 15, 0, Math.PI * 2);
    cameraCtx.fill();
    cameraCtx.restore();
  }
}

// ==========================================
// 7. 충돌 판정 및 Dwell Time 선택 기능
// ==========================================
function checkDwellSelection(deltaTime) {
  if (!state.isHandActive) {
    resetDwell();
    return;
  }
  
  // O 구역, X 구역의 DOM 위치 정보 획득
  const rectO = els.zoneO.getBoundingClientRect();
  const rectX = els.zoneX.getBoundingClientRect();
  
  const px = state.pointer.x;
  const py = state.pointer.y;
  
  // O 영역 충돌 체크
  if (px >= rectO.left && px <= rectO.right && py >= rectO.top && py <= rectO.bottom) {
    state.dwellO += deltaTime;
    state.dwellX = 0;
    
    els.oBtn.classList.add('hovered');
    els.xBtn.classList.remove('hovered');
    
    const pct = Math.min(state.dwellO / state.targetDwellTime, 1);
    updateDwellRing(els.dwellOProgress, pct);
    updateDwellRing(els.dwellXProgress, 0);
    
    // 오작동 방지용 차징음 생성 (가속 펄스음)
    if (state.dwellO > 100 && Math.floor(state.dwellO / 150) > Math.floor((state.dwellO - deltaTime) / 150)) {
      sounds.tick();
    }
    
    if (state.dwellO >= state.targetDwellTime) {
      triggerAnswer('O');
      resetDwell();
    }
  } 
  // X 영역 충돌 체크
  else if (px >= rectX.left && px <= rectX.right && py >= rectX.top && py <= rectX.bottom) {
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
  
  if (allQuestions.length < 5) {
    alert("출제할 수 있는 문제가 너무 부족해요! 😭\n선생님 방에서 문제를 최소 5개 이상 등록해 주세요.");
    changeScreen('home');
    stopWebcam();
    return;
  }
  
  // 문제를 무작위로 5개 선정해서 게임 리스트에 넣음 (아동 피로도 방지용 5문항 축소)
  state.questions = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, 5);
  
  els.totalQuestionsNum.textContent = state.questions.length;
  showQuestion(state.currentQuestionIndex);
}

function showQuestion(index) {
  const q = state.questions[index];
  
  // 텍스트 및 이모지 바인딩
  els.currentQuestionNum.textContent = index + 1;
  els.questionEmoji.textContent = q.emoji;
  els.questionText.textContent = q.question;
  els.hintText.textContent = q.hint;
  els.scoreStars.textContent = `⭐ ${state.score}`;
  
  // 게이지 초기화
  resetDwell();
  
  // 타이머 15초 세팅
  state.timer = 15;
  els.timerText.textContent = state.timer;
  els.timerBar.style.width = '100%';
  
  if (state.timerInterval) clearInterval(state.timerInterval);
  
  state.timerInterval = setInterval(() => {
    state.timer--;
    els.timerText.textContent = state.timer;
    els.timerBar.style.width = `${(state.timer / 15) * 100}%`;
    
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
  setTimeout(() => {
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
