// ==UserScript==
// @name         DeadLine Scanner: Total Envio Edition (Aceleração Nativa + Foco + HUD + Anti-Teclado)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Aimbot focado no fluxo Rastreio -> CEP -> Adicionar. Bloqueia o teclado do celular durante o scan.
// @match        https://portal.totalenvios.com.br/*
// @match        http://portal.totalenvios.com.br/*
// @updateURL    https://raw.githubusercontent.com/IsaqueAmancio/total-scanner/main/totalScanner.user.js
// @downloadURL  https://raw.githubusercontent.com/IsaqueAmancio/total-scanner/main/totalScanner.user.js
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  let scannerContainer = null;
  let panelContainer = null;
  let videoElement = null;
  let scanAreaElement = null;
  let stream = null;
  let scanAnimation = null;
  let hardwareDetector = null;
  let hudInterval = null;

  let lockedTargetInputs = [];
  let originalInputModes = []; // Guarda os modos de entrada originais para restaurar depois
  let currentInputIndex = 0;
  let lockedTargetButton = null;

  let lastScanTime = 0;
  const COOLDOWN_MS = 2000;

  // Cache leve para evitar que o HUD reconstrua o DOM sem necessidade durante a leitura
  let lastHudSignature = "";
  // Controle para evitar chamadas concorrentes ao decodificador de hardware
  let isDetectingFrame = false;

  // OTIMIZAÇÃO 1: Removido 'willReadFrequently: true' (que forçava CPU lenta).
  // Usamos 'alpha: false' e 'desynchronized: true' para manter tudo 100% na GPU com latência zero.
  const hiddenCanvas = document.createElement("canvas");
  const ctx = hiddenCanvas.getContext("2d", {
    alpha: false,
    desynchronized: true,
  });

  function createControlPanel() {
    if (document.getElementById("deadline-control-panel")) return;

    panelContainer = document.createElement("div");
    panelContainer.id = "deadline-control-panel";

    Object.assign(panelContainer.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "999998",
      padding: "15px",
      backgroundColor: "#1e1e1e",
      border: "2px solid #555",
      borderRadius: "8px",
      boxShadow: "0 4px 15px rgba(0,0,0,0.5)",
      fontFamily: "sans-serif",
      color: "#fff",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      width: "250px",
    });

    const titleText = document.createElement("div");
    titleText.innerHTML =
      "🎯 <b>DeadLine: Total Envio</b><br><small>Alvos: Rastreio -> CEP -> Adicionar</small>";
    titleText.style.fontSize = "12px";
    titleText.style.textAlign = "center";

    const scanBtn = document.createElement("button");
    scanBtn.innerText = "📸 Iniciar Câmera";
    Object.assign(scanBtn.style, {
      padding: "10px",
      cursor: "pointer",
      backgroundColor: "#00ff00",
      color: "#000",
      border: "none",
      borderRadius: "4px",
      fontWeight: "bold",
    });

    scanBtn.onclick = () => {
      if (lockHardcodedTargets()) {
        panelContainer.style.display = "none";
        showScannerUI();
        initScannerLogic();
      }
    };

    panelContainer.appendChild(titleText);
    panelContainer.appendChild(scanBtn);
    document.body.appendChild(panelContainer);
  }

  function lockHardcodedTargets() {
    const inputRastreio = document.getElementById("rastreio");
    const inputCep = document.getElementById("cep");
    const btnAdicionar = document.getElementById("adicionar");

    if (!inputRastreio || !inputCep) {
      alert(
        "DeadLine informa: Abortando missão. Não consegui encontrar os campos 'rastreio' ou 'cep' na tela.",
      );
      return false;
    }

    lockedTargetInputs = [inputRastreio, inputCep];

    // Bloqueia o teclado virtual do celular de aparecer nesses campos
    originalInputModes = [
      inputRastreio.getAttribute("inputmode"),
      inputCep.getAttribute("inputmode"),
    ];
    inputRastreio.setAttribute("inputmode", "none");
    inputCep.setAttribute("inputmode", "none");

    lockedTargetButton = btnAdicionar;
    currentInputIndex = 0;

    return true;
  }

  // Função que atualiza o painel HUD (Otimizada para não travar a thread de vídeo)
  function updateHUD() {
    if (!document.getElementById("deadline-hud")) return;

    const inputRastreio = document.getElementById("rastreio");
    const inputCep = document.getElementById("cep");
    const qtdeText = document.getElementById("frase-qtde-objetos");
    const tbody = document.querySelector("#tabela-objetos tbody");

    const rastVal =
      inputRastreio && inputRastreio.value ? inputRastreio.value : "---";
    const cepVal = inputCep && inputCep.value ? inputCep.value : "---";
    const qtdeVal = qtdeText ? qtdeText.innerText : "";
    const rowCount = tbody ? tbody.rows.length : 0;

    // Só reconstrói o DOM se algum dado realmente mudou desde a última checagem
    const currentSignature = `${rastVal}|${cepVal}|${qtdeVal}|${rowCount}`;
    if (currentSignature === lastHudSignature) return;
    lastHudSignature = currentSignature;

    document.getElementById("hud-rastreio").innerText = rastVal;
    document.getElementById("hud-cep").innerText = cepVal;

    if (qtdeText) {
      document.getElementById("hud-qtde").innerText = qtdeVal;
    }

    const listEl = document.getElementById("hud-list");
    listEl.innerHTML = "";

    if (tbody) {
      const rows = Array.from(tbody.querySelectorAll("tr"));

      if (rows.length === 0) {
        listEl.innerHTML =
          '<li style="color:#777;">Nenhum pacote na tabela ainda.</li>';
      } else {
        const recentRows = rows.reverse().slice(0, 4);

        recentRows.forEach((tr) => {
          const tds = tr.querySelectorAll("td");
          if (tds.length >= 2) {
            const li = document.createElement("li");
            li.style.marginBottom = "3px";
            li.innerHTML = `📦 <b>${tds[0].innerText}</b> (CEP: ${tds[1].innerText})`;
            listEl.appendChild(li);
          }
        });
      }
    }
  }

  function showScannerUI() {
    if (document.getElementById("deadline-qr-wrapper")) return;

    scannerContainer = document.createElement("div");
    scannerContainer.id = "deadline-qr-wrapper";
    Object.assign(scannerContainer.style, {
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: "90vw",
      maxWidth: "450px",
      height: "80vh",
      maxHeight: "750px",
      backgroundColor: "#000",
      borderRadius: "16px",
      zIndex: "999999",
      boxShadow: "0 10px 30px rgba(0,0,0,0.8)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
    });

    const feedbackTop = document.createElement("div");
    feedbackTop.id = "deadline-seq-feedback";
    feedbackTop.innerText = `Lendo Alvo 1 de ${lockedTargetInputs.length} (Rastreio)`;
    Object.assign(feedbackTop.style, {
      backgroundColor: "#3700b3",
      color: "#fff",
      fontWeight: "bold",
      padding: "12px",
      textAlign: "center",
      fontSize: "15px",
      zIndex: "2",
    });

    const videoWrapper = document.createElement("div");
    Object.assign(videoWrapper.style, {
      position: "relative",
      flex: "1",
      width: "100%",
      overflow: "hidden",
    });

    videoElement = document.createElement("video");
    videoElement.id = "deadline-qr-video";
    Object.assign(videoElement.style, {
      width: "100%",
      height: "100%",
      objectFit: "cover",
    });
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.muted = true; // Garante autoplay imediato sem bloqueio de política de áudio

    scanAreaElement = document.createElement("div");
    Object.assign(scanAreaElement.style, {
      position: "absolute",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: "80%",
      aspectRatio: "2 / 1",
      boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.65)",
      border: "2px solid rgba(255,255,255,0.4)",
      zIndex: "1",
      display: "flex",
      justifyContent: "space-between",
      flexDirection: "column",
    });

    const cornerStyle = `width: 30px; height: 30px; border-color: #fff; border-style: solid; position: absolute;`;
    scanAreaElement.innerHTML = `
            <div style="${cornerStyle} top: -2px; left: -2px; border-width: 4px 0 0 4px;"></div>
            <div style="${cornerStyle} top: -2px; right: -2px; border-width: 4px 4px 0 0;"></div>
            <div style="${cornerStyle} bottom: -2px; left: -2px; border-width: 0 0 4px 4px;"></div>
            <div style="${cornerStyle} bottom: -2px; right: -2px; border-width: 0 4px 4px 0;"></div>
        `;

    const hudContainer = document.createElement("div");
    hudContainer.id = "deadline-hud";
    Object.assign(hudContainer.style, {
      backgroundColor: "#1a1a1a",
      padding: "10px 15px",
      color: "#fff",
      fontSize: "13px",
      borderTop: "2px solid #3700b3",
      zIndex: "2",
      maxHeight: "160px",
      overflowY: "auto",
    });

    hudContainer.innerHTML = `
            <div style="display:flex; justify-content: space-between; font-family: monospace; font-size: 14px; margin-bottom: 5px;">
                <div><span style="color:#aaa;">Rast:</span> <span id="hud-rastreio" style="color:#00ff00;">---</span></div>
                <div><span style="color:#aaa;">CEP:</span> <span id="hud-cep" style="color:#00ff00;">---</span></div>
            </div>
            <div style="border-bottom: 1px dashed #444; margin: 5px 0;"></div>
            <div id="hud-qtde" style="color: #ff9800; font-weight: bold; margin-bottom: 5px;">📦 Carregando objetos...</div>
            <ul id="hud-list" style="margin: 0; padding-left: 0; list-style: none; font-size: 12px; color: #ccc;">
                <li style="color:#777;">Aguardando bipagem...</li>
            </ul>
        `;

    const closeBtn = document.createElement("button");
    closeBtn.innerText = "ENCERRAR MISSÃO";
    Object.assign(closeBtn.style, {
      width: "100%",
      padding: "12px",
      cursor: "pointer",
      backgroundColor: "#ff4500",
      color: "#fff",
      border: "none",
      fontWeight: "bold",
      fontSize: "14px",
      zIndex: "2",
    });
    closeBtn.onclick = stopScanner;

    videoWrapper.appendChild(videoElement);
    videoWrapper.appendChild(scanAreaElement);

    scannerContainer.appendChild(feedbackTop);
    scannerContainer.appendChild(videoWrapper);
    scannerContainer.appendChild(hudContainer);
    scannerContainer.appendChild(closeBtn);
    document.body.appendChild(scannerContainer);
  }

  function updateSequenceFeedback() {
    const fb = document.getElementById("deadline-seq-feedback");
    if (fb) {
      const nomeAlvo = currentInputIndex === 0 ? "Rastreio" : "CEP";
      fb.innerText = `Lendo Alvo ${currentInputIndex + 1} de ${lockedTargetInputs.length} (${nomeAlvo})`;
    }
  }

  async function initScannerLogic() {
    try {
      if (!("BarcodeDetector" in window)) {
        alert(
          "DeadLine informa: O seu navegador não possui a API de BarcodeDetector nativa.",
        );
        stopScanner();
        return;
      }

      hardwareDetector = new BarcodeDetector({
        formats: [
          "qr_code",
          "ean_13",
          "ean_8",
          "upc_a",
          "upc_e",
          "code_128",
          "code_39",
          "code_93",
          "itf",
        ],
      });

      currentInputIndex = 0;
      lastHudSignature = "";

      // OTIMIZAÇÃO 2: Resolução 720p (1280x720) a 60fps processa até 2.5x mais rápido que 1080p
      // sem perder nitidez para códigos de barras, evitando queda de FPS do sensor da câmera.
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60, min: 30 },
        },
      });

      // OTIMIZAÇÃO 3: Força foco e exposição contínuos diretamente no hardware da lente
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack && typeof videoTrack.getCapabilities === "function") {
        const capabilities = videoTrack.getCapabilities();
        const advancedConstraints = {};

        if (
          capabilities.focusMode &&
          capabilities.focusMode.includes("continuous")
        ) {
          advancedConstraints.focusMode = "continuous";
        }
        if (
          capabilities.exposureMode &&
          capabilities.exposureMode.includes("continuous")
        ) {
          advancedConstraints.exposureMode = "continuous";
        }

        if (Object.keys(advancedConstraints).length > 0) {
          videoTrack
            .applyConstraints({ advanced: [advancedConstraints] })
            .catch(() => {});
        }
      }

      videoElement.srcObject = stream;

      videoElement.addEventListener(
        "loadeddata",
        () => {
          scanFrameNative();
          hudInterval = setInterval(updateHUD, 300);
        },
        { once: true },
      );
    } catch (err) {
      alert("Erro de Hardware: " + err.message);
      stopScanner();
    }
  }

  async function scanFrameNative() {
    if (
      !videoElement ||
      videoElement.readyState < videoElement.HAVE_ENOUGH_DATA ||
      isDetectingFrame
    ) {
      scanAnimation = requestAnimationFrame(scanFrameNative);
      return;
    }

    isDetectingFrame = true;

    try {
      const vWidth = videoElement.videoWidth;
      const vHeight = videoElement.videoHeight;
      const minDim = Math.min(vWidth, vHeight);

      // OTIMIZAÇÃO 4: Operador bitwise (| 0) garante números inteiros exatos,
      // evitando sub-pixel rendering (borrão nas barras do código).
      const cropWidth = (minDim * 0.85) | 0;
      const cropHeight = (cropWidth * 0.5) | 0;

      const sx = ((vWidth - cropWidth) * 0.5) | 0;
      const sy = ((vHeight - cropHeight) * 0.5) | 0;

      // OTIMIZAÇÃO 5: Só redimensiona o canvas se o tamanho realmente mudou!
      // Evita realocar memória de vídeo 60 vezes por segundo.
      if (
        hiddenCanvas.width !== cropWidth ||
        hiddenCanvas.height !== cropHeight
      ) {
        hiddenCanvas.width = cropWidth;
        hiddenCanvas.height = cropHeight;
        ctx.imageSmoothingEnabled = false; // Mantém as bordas do código de barras ultra nítidas
      }

      ctx.drawImage(
        videoElement,
        sx,
        sy,
        cropWidth,
        cropHeight,
        0,
        0,
        cropWidth,
        cropHeight,
      );

      const barcodes = await hardwareDetector.detect(hiddenCanvas);

      if (barcodes.length > 0 && lockedTargetInputs.length > 0) {
        const resultText = barcodes[0].rawValue;
        const currentTime = Date.now();

        if (currentTime - lastScanTime >= COOLDOWN_MS) {
          lastScanTime = currentTime;

          if (navigator.vibrate) {
            navigator.vibrate(150);
          }

          let targetElement = lockedTargetInputs[currentInputIndex];

          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          ).set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(targetElement, resultText);
          } else {
            targetElement.value = resultText;
          }

          targetElement.dispatchEvent(new Event("input", { bubbles: true }));
          targetElement.dispatchEvent(new Event("change", { bubbles: true }));
          targetElement.dispatchEvent(
            new KeyboardEvent("keydown", {
              bubbles: true,
              key: "Enter",
              keyCode: 13,
            }),
          );
          targetElement.dispatchEvent(
            new KeyboardEvent("keyup", {
              bubbles: true,
              key: "Enter",
              keyCode: 13,
            }),
          );

          // Força a remoção de foco do campo (evita que o teclado suba de qualquer maneira)
          targetElement.blur();
          if (document.activeElement) document.activeElement.blur();

          const originalBg = targetElement.style.backgroundColor;
          targetElement.style.backgroundColor = "#ccffcc";
          setTimeout(() => {
            targetElement.style.backgroundColor = originalBg;
          }, 500);

          const originalBorder = scanAreaElement.style.borderColor;
          scanAreaElement.style.border = "2px solid #00ff00";
          setTimeout(() => {
            scanAreaElement.style.border = "2px solid rgba(255,255,255,0.4)";
          }, 400);

          currentInputIndex++;

          if (currentInputIndex >= lockedTargetInputs.length) {
            if (lockedTargetButton) {
              setTimeout(() => {
                lockedTargetButton.click();
              }, 300);
            }
            currentInputIndex = 0;
          }

          updateSequenceFeedback();
        }
      }
    } catch (err) {
      // Ignorado para performance
    } finally {
      isDetectingFrame = false;
    }

    if (scannerContainer) {
      scanAnimation = requestAnimationFrame(scanFrameNative);
    }
  }

  function stopScanner() {
    if (scanAnimation) {
      cancelAnimationFrame(scanAnimation);
      scanAnimation = null;
    }
    if (hudInterval) {
      clearInterval(hudInterval);
      hudInterval = null;
    }
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    if (scannerContainer) {
      scannerContainer.remove();
      scannerContainer = null;
    }
    if (panelContainer) {
      panelContainer.style.display = "flex";
    }

    // Restaura o estado normal dos campos (remove o bloqueio do teclado)
    if (lockedTargetInputs.length === 2) {
      if (originalInputModes[0] !== null)
        lockedTargetInputs[0].setAttribute("inputmode", originalInputModes[0]);
      else lockedTargetInputs[0].removeAttribute("inputmode");

      if (originalInputModes[1] !== null)
        lockedTargetInputs[1].setAttribute("inputmode", originalInputModes[1]);
      else lockedTargetInputs[1].removeAttribute("inputmode");
    }

    currentInputIndex = 0;
    hardwareDetector = null;
    isDetectingFrame = false;
  }

  if (document.readyState === "complete") {
    createControlPanel();
  } else {
    window.addEventListener("load", createControlPanel);
  }
})();
