const startView = document.getElementById('start-view');
const stopView = document.getElementById('stop-view');
const stopBtn = document.getElementById('stop-btn');
const activeModeText = document.getElementById('active-mode-text');
const wsDot = document.getElementById('ws-dot');
const wsText = document.getElementById('ws-text');

const MODE_LABELS = {
  'tab-slides': 'Вкладка: звук + слайды',
  'tab-audio-only': 'Вкладка: только звук',
  'mic-only': 'Микрофон (офлайн-лекция)',
};

function renderStatus(status) {
  if (status.capturing) {
    startView.style.display = 'none';
    stopView.style.display = 'block';
    activeModeText.textContent = MODE_LABELS[status.mode] || 'Запись идёт';
  } else {
    startView.style.display = 'flex';
    stopView.style.display = 'none';
  }

  wsDot.className = `dot ${status.wsConnected ? 'on' : status.capturing ? 'warn' : ''}`;
  if (!status.capturing && status.error) {
    wsDot.className = 'dot warn';
    wsText.textContent = 'Не удалось начать запись (доступ к микрофону?)';
    return;
  }
  wsText.textContent = status.capturing
    ? status.wsConnected
      ? 'Подключено к приложению'
      : 'Запись идёт, переподключение...'
    : 'Приложение не подключено';
}

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'popup-start', mode: btn.dataset.mode }, (response) => {
      if (response) renderStatus(response);
      if (response?.error) wsText.textContent = 'Не удалось начать запись';
    });
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'popup-stop' }, (response) => {
    if (response) renderStatus(response);
  });
});

// Live updates while the popup happens to be open.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'status-update') renderStatus(message.status);
});

chrome.runtime.sendMessage({ type: 'get-status' }, (response) => {
  if (response) renderStatus(response);
});
