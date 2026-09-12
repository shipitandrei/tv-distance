import {
  FaceDetector,
  FilesetResolver
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs";


const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/" +
  "face_detector/blaze_face_short_range/float16/1/" +
  "blaze_face_short_range.tflite";

const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";


const $ = selector =>
  document.querySelector(selector);


const video = $("#video");
const monitor = $("#monitor");

const state = $("#state");
const debug = $("#debug");

const startButton = $("#start");
const calibrateButton = $("#calibrate");

const recalibrateButton =
  $("#recalibrate");

const stopButton = $("#stop");

const threshold =
  $("#threshold");

const thresholdValue =
  $("#thresholdValue");

const delay =
  $("#delay");

const delayValue =
  $("#delayValue");

const status =
  $("#status");

const alarmFile =
  $("#alarmFile");

const audioStatus =
  $("#audioStatus");


let detector = null;
let stream = null;

let running = false;

let safeFaceWidth =
  Number(
    localStorage.getItem(
      "safeFaceWidth"
    )
  ) || null;

let currentFaceWidth = null;

let candidateSince = 0;

let alarmRunning = false;

let alarmAudio = null;
let audioURL = null;

let audioContext = null;

let wakeLock = null;

let lastVideoTime = -1;
let lastDetection = 0;

let fallbackInterval = null;


/*
 * Settings
 */

threshold.addEventListener(
  "input",
  () => {

    thresholdValue.textContent =
      `${threshold.value}%`;
  }
);


delay.addEventListener(
  "input",
  () => {

    delayValue.textContent =
      `${(
        Number(delay.value) / 1000
      ).toFixed(1)}s`;
  }
);


/*
 * IndexedDB
 */

async function openDatabase() {

  return new Promise(
    (resolve, reject) => {

      const request =
        indexedDB.open(
          "tv-distance-alarm",
          1
        );


      request.onupgradeneeded =
        () => {

          request.result
            .createObjectStore(
              "settings"
            );
        };


      request.onsuccess =
        () => {

          resolve(
            request.result
          );
        };


      request.onerror =
        () => {

          reject(
            request.error
          );
        };

    }
  );
}


async function saveAlarm(blob) {

  const database =
    await openDatabase();


  await new Promise(
    (resolve, reject) => {

      const transaction =
        database.transaction(
          "settings",
          "readwrite"
        );


      transaction
        .objectStore("settings")
        .put(
          blob,
          "alarm"
        );


      transaction.oncomplete =
        resolve;


      transaction.onerror =
        () => {

          reject(
            transaction.error
          );
        };

    }
  );
}


async function loadAlarm() {

  const database =
    await openDatabase();


  return new Promise(
    (resolve, reject) => {

      const transaction =
        database.transaction(
          "settings",
          "readonly"
        );


      const request =
        transaction
          .objectStore("settings")
          .get("alarm");


      request.onsuccess =
        () => {

          resolve(
            request.result || null
          );
        };


      request.onerror =
        () => {

          reject(
            request.error
          );
        };

    }
  );
}


/*
 * Alarm audio
 */

function setAlarmAudio(
  blob,
  filename = "Saved alarm"
) {

  if (audioURL) {

    URL.revokeObjectURL(
      audioURL
    );
  }


  audioURL =
    URL.createObjectURL(
      blob
    );


  alarmAudio =
    new Audio(
      audioURL
    );


  alarmAudio.preload =
    "auto";

  alarmAudio.loop =
    true;


  audioStatus.textContent =
    `Alarm loaded: ${filename}`;
}


alarmFile.addEventListener(
  "change",
  async () => {

    const file =
      alarmFile.files[0];


    if (!file) {
      return;
    }


    try {

      await saveAlarm(file);


      setAlarmAudio(
        file,
        file.name
      );


    } catch (error) {

      console.error(error);

      audioStatus.textContent =
        "Could not save alarm audio.";
    }

  }
);


/*
 * Face detector
 */

async function initializeDetector() {

  status.textContent =
    "Loading face detector...";


  const vision =
    await FilesetResolver
      .forVisionTasks(
        WASM_URL
      );


  detector =
    await FaceDetector
      .createFromOptions(
        vision,
        {
          baseOptions: {
            modelAssetPath:
              MODEL_URL,

            delegate:
              "CPU"
          },

          runningMode:
            "VIDEO",

          minDetectionConfidence:
            0.5,

          minSuppressionThreshold:
            0.3
        }
      );
}


/*
 * Camera
 */

async function startCamera() {

  if (
    !navigator.mediaDevices ||
    !navigator.mediaDevices
      .getUserMedia
  ) {

    throw new Error(
      "Camera access is not supported."
    );
  }


  stream =
    await navigator.mediaDevices
      .getUserMedia(
        {
          video: {
            facingMode: {
              ideal: "user"
            },

            width: {
              ideal: 640,
              max: 960
            },

            height: {
              ideal: 480,
              max: 720
            },

            frameRate: {
              ideal: 15,
              max: 20
            }
          },

          audio: false
        }
      );


  video.srcObject =
    stream;


  await video.play();


  /*
   * Start the audio context from
   * the user's Start button press.
   */

  audioContext =
    new (
      window.AudioContext ||
      window.webkitAudioContext
    )();


  await audioContext.resume();


  /*
   * Keep screen awake.
   */

  try {

    if (
      "wakeLock" in navigator
    ) {

      wakeLock =
        await navigator
          .wakeLock
          .request("screen");
    }

  } catch (error) {

    console.warn(
      "Wake Lock unavailable:",
      error
    );
  }


  monitor.hidden =
    false;

  $("#setup").hidden =
    true;

  calibrateButton.disabled =
    false;

  running =
    true;


  requestAnimationFrame(
    loop
  );
}


/*
 * Find largest face.
 */

function getLargestFace(
  result
) {

  if (
    !result ||
    !result.detections ||
    result.detections.length === 0
  ) {

    return null;
  }


  return result.detections
    .reduce(
      (largest, current) => {

        if (!largest) {
          return current;
        }


        const largestArea =
          largest.boundingBox.width *
          largest.boundingBox.height;


        const currentArea =
          current.boundingBox.width *
          current.boundingBox.height;


        return currentArea >
          largestArea
          ? current
          : largest;

      },
      null
    );
}


/*
 * Face width ratio
 */

function getFaceWidthRatio(
  face
) {

  return (
    face.boundingBox.width /
    video.videoWidth
  );
}


/*
 * Calibration
 */

function calibrate() {

  /*
   * Restore the large camera preview
   * while calibrating.
   */

  monitor.classList.remove(
    "calibrated"
  );


  if (!currentFaceWidth) {

    state.textContent =
      "NO FACE";

    debug.textContent =
      "Put a face in view first.";

    return;
  }


  safeFaceWidth =
    currentFaceWidth;


  localStorage.setItem(
    "safeFaceWidth",
    String(
      safeFaceWidth
    )
  );


  candidateSince =
    0;


  stopAlarm();


  /*
   * Minimize camera after
   * calibration is complete.
   */

  monitor.classList.add(
    "calibrated"
  );


  state.textContent =
    "CALIBRATED";


  debug.textContent =
    `Safe face width: ${
      (
        safeFaceWidth * 100
      ).toFixed(1)
    }%`;
}


/*
 * Alarm
 */

async function startAlarm() {

  if (alarmRunning) {
    return;
  }


  alarmRunning =
    true;


  monitor.classList.add(
    "alarm"
  );


  if (alarmAudio) {

    try {

      alarmAudio.currentTime =
        0;

      await alarmAudio.play();

    } catch (error) {

      console.warn(
        "Could not play alarm:",
        error
      );
    }

  } else {

    startFallbackAlarm();
  }


  if (
    navigator.vibrate
  ) {

    navigator.vibrate([
      300,
      80,
      300,
      80,
      300
    ]);
  }
}


function startFallbackAlarm() {

  if (fallbackInterval) {
    return;
  }


  const beep = () => {

    if (
      !alarmRunning ||
      !audioContext
    ) {
      return;
    }


    const now =
      audioContext.currentTime;


    const oscillator =
      audioContext
        .createOscillator();


    const gain =
      audioContext
        .createGain();


    oscillator.type =
      "square";


    oscillator.frequency
      .setValueAtTime(
        900,
        now
      );


    oscillator.frequency
      .setValueAtTime(
        550,
        now + 0.18
      );


    gain.gain.setValueAtTime(
      0.0001,
      now
    );


    gain.gain
      .exponentialRampToValueAtTime(
        0.32,
        now + 0.02
      );


    gain.gain
      .exponentialRampToValueAtTime(
        0.0001,
        now + 0.35
      );


    oscillator.connect(
      gain
    );


    gain.connect(
      audioContext.destination
    );


    oscillator.start(
      now
    );


    oscillator.stop(
      now + 0.36
    );
  };


  beep();


  fallbackInterval =
    setInterval(
      beep,
      430
    );
}


function stopAlarm() {

  alarmRunning =
    false;


  monitor.classList.remove(
    "alarm"
  );


  if (
    alarmAudio &&
    alarmAudio.pause
  ) {

    alarmAudio.pause();

    alarmAudio.currentTime =
      0;
  }


  if (fallbackInterval) {

    clearInterval(
      fallbackInterval
    );

    fallbackInterval =
      null;
  }


  if (
    navigator.vibrate
  ) {

    navigator.vibrate(0);
  }
}


/*
 * Distance evaluation
 */

function evaluateDistance(
  width,
  timestamp
) {

  currentFaceWidth =
    width;


  if (!safeFaceWidth) {

    state.textContent =
      "CALIBRATE";


    debug.textContent =
      `Face ${
        (width * 100).toFixed(1)
      }% wide`;


    stopAlarm();

    return;
  }


  const multiplier =
    Number(
      threshold.value
    ) / 100;


  const tooClose =
    width >=
    safeFaceWidth *
    multiplier;


  if (tooClose) {

    if (!candidateSince) {

      candidateSince =
        timestamp;
    }


    const elapsed =
      timestamp -
      candidateSince;


    const requiredDelay =
      Number(
        delay.value
      );


    if (
      elapsed >=
      requiredDelay
    ) {

      state.textContent =
        "TOO CLOSE";


      debug.textContent =
        `Face ${
          (width * 100).toFixed(1)
        }% wide`;


      startAlarm();

    } else {

      state.textContent =
        "GET BACK";


      debug.textContent =
        `Alarm in ${
          Math.max(
            0,
            (
              requiredDelay -
              elapsed
            ) / 1000
          ).toFixed(1)
        }s`;
    }

  } else {

    candidateSince =
      0;


    stopAlarm();


    state.textContent =
      "SAFE";


    debug.textContent =
      `Face ${
        (width * 100).toFixed(1)
      }% wide`;
  }
}


/*
 * Detection loop
 */

function loop(timestamp) {

  if (!running) {
    return;
  }


  if (
    video.readyState >= 2 &&
    video.currentTime !==
      lastVideoTime
  ) {

    lastVideoTime =
      video.currentTime;


    /*
     * Approximately 8 detections
     * per second.
     */

    if (
      timestamp -
      lastDetection >=
      120
    ) {

      lastDetection =
        timestamp;


      try {

        const result =
          detector.detectForVideo(
            video,
            timestamp
          );


        const face =
          getLargestFace(
            result
          );


        if (face) {

          const width =
            getFaceWidthRatio(
              face
            );


          evaluateDistance(
            width,
            timestamp
          );

        } else {

          currentFaceWidth =
            null;

          candidateSince =
            0;


          stopAlarm();


          state.textContent =
            "NO FACE";


          debug.textContent =
            "No face detected";
        }


      } catch (error) {

        console.error(
          error
        );


        debug.textContent =
          "Detection error.";
      }
    }
  }


  requestAnimationFrame(
    loop
  );
}


/*
 * Stop monitoring
 */

async function stopMonitoring() {

  running =
    false;


  stopAlarm();


  if (stream) {

    stream
      .getTracks()
      .forEach(
        track =>
          track.stop()
      );

    stream =
      null;
  }


  video.srcObject =
    null;


  if (wakeLock) {

    try {

      await wakeLock.release();

    } catch (_) {}

    wakeLock =
      null;
  }


  monitor.hidden =
    true;


  monitor.classList.remove(
    "calibrated"
  );


  $("#setup").hidden =
    false;


  calibrateButton.disabled =
    true;


  startButton.disabled =
    false;


  status.textContent =
    "Monitoring stopped.";
}


/*
 * Start
 */

startButton.addEventListener(
  "click",
  async () => {

    startButton.disabled =
      true;


    try {

      await initializeDetector();

      await startCamera();

    } catch (error) {

      console.error(
        error
      );


      status.textContent =
        `Could not start: ${
          error.message
        }`;


      startButton.disabled =
        false;
    }
  }
);


/*
 * Calibration buttons
 */

calibrateButton.addEventListener(
  "click",
  calibrate
);


recalibrateButton.addEventListener(
  "click",
  calibrate
);


/*
 * Stop
 */

stopButton.addEventListener(
  "click",
  stopMonitoring
);


/*
 * Load saved alarm.
 */

(async () => {

  try {

    const saved =
      await loadAlarm();


    if (saved) {

      setAlarmAudio(
        saved,
        "Saved alarm"
      );
    }

  } catch (error) {

    console.warn(
      "Could not load saved alarm:",
      error
    );
  }

})();


/*
 * Service worker
 */

if (
  "serviceWorker" in navigator
) {

  navigator.serviceWorker
    .register("./sw.js")
    .catch(
      console.error
    );
}
