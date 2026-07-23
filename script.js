/* =========================================================================
   WEBCAM HAND-REACTIVE GRID
   Vanilla JS + Three.js (ES modules) + MediaPipe Hands
   Idle: seamless webcam grid, zero motion.
   Hand present: only tiles under the hand's bounding box lift/rotate/separate.
   ========================================================================= */

import * as THREE from 'three';

const DEV_MODE = true; // shows on-screen error panel; set false for production

// ---------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------
const CONFIG = {
GRID_COLS: 16,
GRID_ROWS: 12,

WALL_WIDTH: 20,
WALL_HEIGHT: 11.25,

  // Hand-region interaction
  HAND_PADDING: 1.2,        // world units padded around the hand bbox
  LIFT_Z: 1.6,               // how far touched tiles move toward camera
  MAX_ROT: 0.22,             // radians, max tilt for touched tiles
  SEPARATION: 0.06,          // extra spacing scale applied to touched tiles

  // Spring motion
  SPRING_STIFFNESS: 0.16,
  SPRING_DAMPING: 0.72,
  ROT_SPRING_STIFFNESS: 0.16,
  ROT_SPRING_DAMPING: 0.72,

  SMOOTHING: 0.45,
  HAND_TRACKING_TIMEOUT_MS: 10000,
};

// ---------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------
const videoEl = document.getElementById('webcam');
const loaderEl = document.getElementById('loader');
const loaderTextEl = document.getElementById('loaderText');
const permErrorEl = document.getElementById('permissionError');
const permErrorBodyEl = document.getElementById('permErrorBody');
const handStatusDot = document.getElementById('handStatus');
const handStatusText = document.getElementById('handStatusText');
const warningBannerEl = document.getElementById('warningBanner');
const errorPanelEl = document.getElementById('errorPanel');
const glCanvas = document.getElementById('glCanvas');

// ---------------------------------------------------------------------
// ERROR / WARNING UI HELPERS
// ---------------------------------------------------------------------
function logError(context, err) {
  console.error(`[HandGrid] ${context}:`, err);
  if (!DEV_MODE) return;
  errorPanelEl.classList.remove('hidden');
  const title = errorPanelEl.querySelector('.err-title');
  if (!title) {
    errorPanelEl.innerHTML = '<span class="err-title">Dev Error Log</span>';
  }
  const line = document.createElement('div');
  const msg = err && err.message ? err.message : String(err);
  line.textContent = `• ${context}: ${msg}`;
  errorPanelEl.appendChild(line);
}

let warningTimeout = null;
function showWarning(text, autoHideMs) {
  warningBannerEl.textContent = text;
  warningBannerEl.classList.remove('hidden');
  if (warningTimeout) clearTimeout(warningTimeout);
  if (autoHideMs) {
    warningTimeout = setTimeout(() => {
      warningBannerEl.classList.add('hidden');
    }, autoHideMs);
  }
}
function hideWarning() {
  warningBannerEl.classList.add('hidden');
}

function hideLoader() {
  loaderEl.classList.add('hidden');
}

function setLoaderText(text) {
  if (loaderTextEl) loaderTextEl.textContent = text;
}

function setHandStatus(mode) {
  // mode: 'off' | 'pending' | 'on'
  handStatusDot.classList.remove('dot-off', 'dot-pending', 'dot-on');
  handStatusDot.classList.add(`dot-${mode}`);
  handStatusText.textContent =
    mode === 'on' ? 'hand tracked' : mode === 'pending' ? 'tracking loading…' : 'no hand';
}

// ---------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------
const state = {
  handTracking: null,
  handActive: false,
  lastHandSeenAt: 0,
  time: 0,
  handTrackingReady: false,
  handTrackingFailed: false,
  _lastStatusFlag: null,
};

// ---------------------------------------------------------------------
// THREE.JS SETUP
// ---------------------------------------------------------------------
let renderer, scene, camera;
let tileGroup;
let videoTexture;
const tiles = [];

function initThree() {
  renderer = new THREE.WebGLRenderer({
    canvas: glCanvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 14);
  camera.lookAt(0, 0, 0);

  // Minimal flat lighting — MeshBasicMaterial doesn't need it, but kept
  // negligible ambient in case any future non-basic elements are added.
  const ambient = new THREE.AmbientLight(0xffffff, 1);
  scene.add(ambient);

  tileGroup = new THREE.Group();
  scene.add(tileGroup);

  window.addEventListener('resize', onResize);
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function initVideoTexture() {
  videoTexture = new THREE.VideoTexture(videoEl);
  videoTexture.colorSpace = THREE.SRGBColorSpace;
  videoTexture.minFilter = THREE.LinearFilter;
  videoTexture.magFilter = THREE.LinearFilter;
  videoTexture.generateMipmaps = false;
  videoTexture.wrapS = THREE.ClampToEdgeWrapping;
  videoTexture.wrapT = THREE.ClampToEdgeWrapping;
}

// ---------------------------------------------------------------------
// TILE CLASS — fixed grid cell, no randomness, moves only when touched
// ---------------------------------------------------------------------
class Tile {
  constructor(gridX, gridY) {
    this.gridX = gridX;
    this.gridY = gridY;

    const cellW = CONFIG.WALL_WIDTH / CONFIG.GRID_COLS;
    const cellH = CONFIG.WALL_HEIGHT / CONFIG.GRID_ROWS;

    const homeX = (gridX - CONFIG.GRID_COLS / 2 + 0.5) * cellW;
    const homeY = (gridY - CONFIG.GRID_ROWS / 2 + 0.5) * cellH;
    const homeZ = (this.gridY * CONFIG.GRID_COLS + this.gridX) * 0.00001;

    this.home = new THREE.Vector3(homeX, homeY, homeZ);
    this.pos = this.home.clone();
    this.vel = new THREE.Vector3();

    this.homeRot = new THREE.Euler(0, 0, 0);
    this.rot = new THREE.Euler(0, 0, 0);
    this.rotVel = new THREE.Vector3();

    this.width = cellW;
    this.height = cellH;

    // Each tile samples exactly its own webcam region — seamless mosaic.
    const cols = CONFIG.GRID_COLS;
    const rows = CONFIG.GRID_ROWS;
    this.uvOffsetX = gridX / cols;
    this.uvOffsetY = 1 - (gridY + 1) / rows;
    this.uvScaleX = 1 / cols;
    this.uvScaleY = 1 / rows;

    // Reused scratch vectors to avoid per-frame allocations.
    this._desired = new THREE.Vector3();
    this._dispX = 0;
    this._dispY = 0;

    this.mesh = this.buildMesh();
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.copy(this.rot);
  }

  buildMesh() {
  const geo = new THREE.PlaneGeometry(
    this.width * 0.98,
    this.height * 0.98

    const uvAttr = geo.attributes.uv;
    for (let i = 0; i < uvAttr.count; i++) {
      const u = uvAttr.getX(i);
      const v = uvAttr.getY(i);
      uvAttr.setXY(
        i,
        this.uvOffsetX + u * this.uvScaleX,
        this.uvOffsetY + v * this.uvScaleY
      );
    }
    uvAttr.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({
      map: videoTexture,
      side: THREE.DoubleSide,
    });

    return new THREE.Mesh(geo, mat);
  }

  // handBox: {minX,maxX,minY,maxY,cx,cy} in world space, or null
  update(handBox) {
    let desiredX = this.home.x;
    let desiredY = this.home.y;
    let desiredZ = this.home.z;
    let targetRotX = 0;
    let targetRotY = 0;

    if (handBox) {
      const inside =
        this.home.x >= handBox.minX &&
        this.home.x <= handBox.maxX &&
        this.home.y >= handBox.minY &&
        this.home.y <= handBox.maxY;

      if (inside) {
        // Normalized position within the hand box, -1..1 on each axis.
        const halfW = (handBox.maxX - handBox.minX) * 0.5 || 1;
        const halfH = (handBox.maxY - handBox.minY) * 0.5 || 1;
        const nx = (this.home.x - handBox.cx) / halfW;
        const ny = (this.home.y - handBox.cy) / halfH;

        desiredZ = this.home.z + CONFIG.LIFT_Z;
        desiredX = this.home.x + nx * CONFIG.SEPARATION;
        desiredY = this.home.y + ny * CONFIG.SEPARATION;

        targetRotX = -ny * CONFIG.MAX_ROT;
        targetRotY = nx * CONFIG.MAX_ROT;
      }
    }

    const ax = (desiredX - this.pos.x) * CONFIG.SPRING_STIFFNESS;
    const ay = (desiredY - this.pos.y) * CONFIG.SPRING_STIFFNESS;
    const az = (desiredZ - this.pos.z) * CONFIG.SPRING_STIFFNESS;

    this.vel.x = (this.vel.x + ax) * CONFIG.SPRING_DAMPING;
    this.vel.y = (this.vel.y + ay) * CONFIG.SPRING_DAMPING;
    this.vel.z = (this.vel.z + az) * CONFIG.SPRING_DAMPING;

    this.pos.x += this.vel.x;
    this.pos.y += this.vel.y;
    this.pos.z += this.vel.z;

    const rax = (targetRotX - this.rot.x) * CONFIG.ROT_SPRING_STIFFNESS;
    const ray = (targetRotY - this.rot.y) * CONFIG.ROT_SPRING_STIFFNESS;

    this.rotVel.x = (this.rotVel.x + rax) * CONFIG.ROT_SPRING_DAMPING;
    this.rotVel.y = (this.rotVel.y + ray) * CONFIG.ROT_SPRING_DAMPING;

    this.rot.x += this.rotVel.x;
    this.rot.y += this.rotVel.y;

    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
    this.mesh.rotation.set(this.rot.x, this.rot.y, 0);
  }
}

// ---------------------------------------------------------------------
// PROGRESSIVE WALL BUILD — avoids a large synchronous stall on startup.
// Builds the FULL fixed grid (every cell), in row-major order, so the
// mosaic always fills in as a seamless rectangle rather than at random.
// ---------------------------------------------------------------------
let wallCells = [];
let wallBuildIndex = 0;
let wallBuildTimer = null;
const TILES_PER_BATCH = 24;
const BATCH_INTERVAL_MS = 16;

function prepareWallCells() {
  const cols = CONFIG.GRID_COLS;
  const rows = CONFIG.GRID_ROWS;
  const cells = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) cells.push([x, y]);
  }
  wallCells = cells;
  wallBuildIndex = 0;
}

function buildWallProgressively(onComplete) {
  prepareWallCells();

  function addBatch() {
    try {
      const end = Math.min(wallBuildIndex + TILES_PER_BATCH, wallCells.length);
      for (; wallBuildIndex < end; wallBuildIndex++) {
        const [gx, gy] = wallCells[wallBuildIndex];
        const tile = new Tile(gx, gy);
        tiles.push(tile);
        tileGroup.add(tile.mesh);
      }
    } catch (err) {
      logError('Tile batch creation', err);
    }

    if (wallBuildIndex < wallCells.length) {
      wallBuildTimer = setTimeout(addBatch, BATCH_INTERVAL_MS);
    } else {
      if (onComplete) onComplete();
    }
  }

  addBatch();
}

// ---------------------------------------------------------------------
// COORDINATE MAPPING
// ---------------------------------------------------------------------
function normToWorld(nx, ny, nz, out) {
  const worldX = (1 - nx - 0.5) * CONFIG.WALL_WIDTH * 1.15;
  const worldY = (0.5 - ny) * CONFIG.WALL_HEIGHT * 1.15;
  const worldZ = (nz || 0) * -8;
  out.set(worldX, worldY, worldZ);
  return out;
}

// ---------------------------------------------------------------------
// MEDIAPIPE HANDS — fully decoupled from render start
// ---------------------------------------------------------------------
let hands, mpCamera;
const smoothedPalm = new THREE.Vector3();
const smoothedFingers = [];
let smoothInit = false;

// Reused scratch objects to avoid per-frame allocations.
const _scratchWorld = new THREE.Vector3();
const handBoxState = {
  active: false,
  minX: 0, maxX: 0, minY: 0, maxY: 0, cx: 0, cy: 0,
};

function onHandsResults(results) {
  try {
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      state.handActive = false;
      updateHandStatus(false);
      return;
    }

    const landmarks = results.multiHandLandmarks[0];

    const wrist = landmarks[0];
    const indexBase = landmarks[5];
    const pinkyBase = landmarks[17];
    const palmNX = (wrist.x + indexBase.x + pinkyBase.x) / 3;
    const palmNY = (wrist.y + indexBase.y + pinkyBase.y) / 3;
    const palmNZ = (wrist.z + indexBase.z + pinkyBase.z) / 3;

    const palmWorld = normToWorld(palmNX, palmNY, palmNZ, _scratchWorld).clone();

    const tipIndices = [4, 8, 12, 16, 20];
    const fingerWorlds = tipIndices.map((idx) => {
      const lm = landmarks[idx];
      return normToWorld(lm.x, lm.y, lm.z, _scratchWorld).clone();
    });

    if (!smoothInit) {
      smoothedPalm.copy(palmWorld);
      fingerWorlds.forEach((f, i) => { smoothedFingers[i] = f.clone(); });
      smoothInit = true;
    } else {
      smoothedPalm.lerp(palmWorld, CONFIG.SMOOTHING);
      fingerWorlds.forEach((f, i) => {
        if (!smoothedFingers[i]) smoothedFingers[i] = f.clone();
        else smoothedFingers[i].lerp(f, CONFIG.SMOOTHING);
      });
    }

    // Bounding box over all landmarks (world space), padded.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < landmarks.length; i++) {
      const w = normToWorld(landmarks[i].x, landmarks[i].y, landmarks[i].z, _scratchWorld);
      if (w.x < minX) minX = w.x;
      if (w.x > maxX) maxX = w.x;
      if (w.y < minY) minY = w.y;
      if (w.y > maxY) maxY = w.y;
    }
    minX -= CONFIG.HAND_PADDING;
    maxX += CONFIG.HAND_PADDING;
    minY -= CONFIG.HAND_PADDING;
    maxY += CONFIG.HAND_PADDING;

    handBoxState.active = true;
    handBoxState.minX = minX;
    handBoxState.maxX = maxX;
    handBoxState.minY = minY;
    handBoxState.maxY = maxY;
    handBoxState.cx = (minX + maxX) * 0.5;
    handBoxState.cy = (minY + maxY) * 0.5;

    state.handTracking = { palm: smoothedPalm, fingers: smoothedFingers };
    state.handActive = true;
    state.lastHandSeenAt = performance.now();
    updateHandStatus(true);
  } catch (err) {
    logError('onHandsResults', err);
  }
}

function updateHandStatus(active) {
  if (active === state._lastStatusFlag) return;
  state._lastStatusFlag = active;
  setHandStatus(active ? 'on' : 'off');
}

function updateHandTimeout() {
  if (state.handActive && performance.now() - state.lastHandSeenAt > 350) {
    state.handActive = false;
    handBoxState.active = false;
    updateHandStatus(false);
  }
}

// Initializes hand tracking asynchronously; never blocks render start.
// Retries in the background if it fails or exceeds the timeout.
function initHandTrackingAsync() {
  setHandStatus('pending');

  let settled = false;
  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    state.handTrackingFailed = true;
    showWarning('Hand tracking is taking longer than expected — running webcam + scene only. Retrying in background…');
    setHandStatus('off');
    // keep retrying quietly in the background
    retryHandTrackingLoop();
  }, CONFIG.HAND_TRACKING_TIMEOUT_MS);

  (async () => {
    try {
      if (typeof Hands === 'undefined' || typeof Camera === 'undefined') {
        throw new Error('MediaPipe Hands/Camera globals not available');
      }

      hands = new Hands({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
      });
      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.65,
        minTrackingConfidence: 0.6,
      });
      hands.onResults(onHandsResults);

      mpCamera = new Camera(videoEl, {
        onFrame: async () => {
          try {
            await hands.send({ image: videoEl });
          } catch (err) {
            // per-frame errors shouldn't crash tracking; log once in a while
            logError('hands.send frame', err);
          }
        },
        width: 640,
        height: 480,
      });
      await mpCamera.start();

      if (settled) return; // timeout already fired; still fine, tracking is now live
      settled = true;
      clearTimeout(timeoutId);
      state.handTrackingReady = true;
      state.handTrackingFailed = false;
      hideWarning();
      setHandStatus('off'); // off until a hand is actually seen
    } catch (err) {
      logError('initHandTrackingAsync', err);
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        state.handTrackingFailed = true;
        showWarning('Hand tracking failed to start — running webcam + scene only. Retrying in background…');
        setHandStatus('off');
        retryHandTrackingLoop();
      }
    }
  })();
}

let retryScheduled = false;
function retryHandTrackingLoop() {
  if (retryScheduled) return;
  retryScheduled = true;
  setTimeout(() => {
    retryScheduled = false;
    if (state.handTrackingReady) return; // succeeded via another path
    initHandTrackingAsync();
  }, 8000);
}

// ---------------------------------------------------------------------
// WEBCAM INIT — first and only blocking step for the loader
// ---------------------------------------------------------------------
async function initWebcam() {
  setLoaderText('requesting camera access');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: false,
  });
  videoEl.srcObject = stream;

  setLoaderText('starting video feed');
  await new Promise((resolve, reject) => {
    const onReady = () => {
      videoEl.play().then(resolve).catch(reject);
    };
    if (videoEl.readyState >= 1) {
      onReady();
    } else {
      videoEl.onloadedmetadata = onReady;
    }
  });

  // Wait for the first real frame so the loader never hides on a black video element
  await new Promise((resolve) => {
    if (videoEl.readyState >= 2) return resolve();
    videoEl.addEventListener('loadeddata', () => resolve(), { once: true });
  });
}

// ---------------------------------------------------------------------
// ANIMATION LOOP — starts as soon as Three.js + first tile batch exist
// ---------------------------------------------------------------------
let lastFrameTime = performance.now();
let animationStarted = false;

function animate(now) {
  requestAnimationFrame(animate);

  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;
  state.time += dt;

  updateHandTimeout();

  const activeHandBox = (state.handActive && handBoxState.active) ? handBoxState : null;

  for (let i = 0; i < tiles.length; i++) {
    tiles[i].update(activeHandBox);
  }

  if (videoTexture) {
    videoTexture.needsUpdate = true;
  }

  try {
    renderer.render(scene, camera);
  } catch (err) {
    logError('renderer.render', err);
  }
}

function startAnimationLoopOnce() {
  if (animationStarted) return;
  animationStarted = true;
  requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------
// INPUT
// ---------------------------------------------------------------------
function initControls() {
  // No keyboard controls, no explode mode — grid reacts to hand only.
}

// ---------------------------------------------------------------------
// BOOT — strict step order per spec, each step isolated by try/catch,
// rendering never blocked on hand tracking.
// ---------------------------------------------------------------------
async function boot() {
  // Step 1 + 2: webcam permission -> visible feed
  try {
    await initWebcam();
  } catch (err) {
    logError('initWebcam', err);
    const msg = err && err.name === 'NotAllowedError'
      ? 'Camera permission was denied. Please allow camera access and reload.'
      : 'Could not access the camera. Please check your device and reload.';
    permErrorBodyEl.textContent = msg;
    permErrorEl.classList.remove('hidden');
    hideLoader();
    return; // nothing else can proceed without the camera
  }

  // Webcam is visible now — loader can come down immediately.
  hideLoader();

  // Step 3: initialize Three.js
  try {
    initThree();
    initVideoTexture();
  } catch (err) {
    logError('initThree', err);
    showWarning('3D renderer failed to initialize. Reload to try again.');
    return;
  }

  // Step 4 + 5: kick off hand tracking asynchronously, and start rendering
  // immediately without waiting for it — build tiles progressively so we
  // never stall the main thread with hundreds of synchronous allocations.
  try {
    initControls();
  } catch (err) {
    logError('initControls', err);
  }

  buildWallProgressively(() => {
    // wall complete — nothing else required, animation loop already running
  });

  // Start the render loop as soon as the renderer + at least the group exist.
  startAnimationLoopOnce();

  // Step 6: hand tracking loads in the background; interaction enables
  // automatically once state.handTrackingReady flips true / hand is seen.
  initHandTrackingAsync();
}

boot();
