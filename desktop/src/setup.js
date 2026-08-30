const urlInput = document.querySelector('#server-url');
const testButton = document.querySelector('#test');
const saveButton = document.querySelector('#save');
const statusBox = document.querySelector('#status');

function setStatus(type, message) {
  statusBox.className = `status visible ${type}`;
  statusBox.textContent = message;
}

function setBusy(busy) {
  testButton.disabled = busy;
  saveButton.disabled = busy;
}

async function run(action) {
  setBusy(true);
  setStatus('testing', action === 'save' ? '正在验证并保存……' : '正在测试连接……');
  try {
    const result = action === 'save'
      ? await window.kexuDesktop.saveServer(urlInput.value)
      : await window.kexuDesktop.testServer(urlInput.value);
    urlInput.value = result.serverUrl;
    setStatus('success', action === 'save' ? '连接成功，正在进入墨痕……' : '连接成功，可以保存并进入。');
  } catch (error) {
    setStatus('error', error.message || '连接失败，请检查地址。');
  } finally {
    setBusy(false);
  }
}

testButton.addEventListener('click', () => run('test'));
saveButton.addEventListener('click', () => run('save'));
urlInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') run('save');
});

window.kexuDesktop.getSettings().then(settings => {
  document.querySelector('#product-name').textContent = settings.productName;
  document.querySelector('#version').textContent = `版本 ${settings.version}`;
  document.querySelector('#role-mark').textContent = settings.role === 'teacher' ? '师' : '学';
  urlInput.value = settings.serverUrl;
  urlInput.focus();
});
