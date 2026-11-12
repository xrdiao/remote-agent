export async function activateQueuedAction(context, resolve, action) {
  const row = await resolve();
  if (!row) throw new Error('这条排队消息已经不在了（可能刚被发出）');
  await context.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.x, y: row.y });
  let point = null;
  for (let i = 0; i < 6 && !point; i++) {
    await new Promise(done => setTimeout(done, 80));
    point = await resolve(action);
  }
  if (!point) throw new Error(context.appMessage('没找到排队消息的操作按钮（可能 {app} 版本不同）'));
  if (point !== true) await context.tapCss(point.x, point.y);
  context.refreshSoon(300);
}
