export async function openCodexSidebar(cdp, deadline, ready) {
  const wait = async (expression, message) => {
    while (Date.now() < deadline) {
      if (await cdp.evaluate(expression, { timeout: Math.max(1, deadline - Date.now()) })) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(message);
  };
  const key = async (value, code, vk, modifiers = 0) => {
    for (const type of ['rawKeyDown', 'keyUp'])
      await cdp.send('Input.dispatchKeyEvent', { type, key: value, code, windowsVirtualKeyCode: vk, modifiers });
  };
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  try {
    await cdp.send('Page.bringToFront');
    await wait(`!!document.querySelector('.monaco-workbench')`, 'Codex 目标工作台尚未加载');
    await key('P', 'KeyP', 80, 10);
    await wait(`!!document.querySelector('.quick-input-widget input')?.getClientRects().length`, 'Codex 目标窗口的命令面板未打开');
    await key('a', 'KeyA', 65, 2);
    await cdp.send('Input.insertText', { text: '>Codex: Open Codex Sidebar' });
    await wait(`([...document.querySelectorAll('.quick-input-list .monaco-list-row')].some(row => row.getClientRects().length && (row.classList.contains('focused') || row.getAttribute('aria-selected') === 'true') && /Codex:\\s*Open Codex Sidebar/i.test(row.textContent)))`, 'Codex 打开侧边栏命令尚未在目标窗口就绪');
    await key('Enter', 'Enter', 13);
    await wait(`!document.querySelector('.quick-input-widget input')?.getClientRects().length`, 'Codex 打开侧边栏命令未执行完成');
    return await ready(() => Date.now() + 25000);
  } finally {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  }
}
