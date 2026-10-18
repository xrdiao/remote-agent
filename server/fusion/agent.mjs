// Fusion：会话侧辅助（项目检查、模型就绪）
import { windowRoots } from '../../lib/files.mjs';
import { helpersCall } from '../page/build.mjs';
import { fusionCursorProjects, fusionModelSpec, fusionProject } from '../fusion/state.mjs';

export const methods = {
  async fusionCheckProject(project) {
    if (this.app === 'cursor') {
      const current = await this.cdp.evaluate(helpersCall('cursorWorkspace()'));
      if (fusionProject(current?.root, current?.host || '')?.id === project?.id) return;
      if (current?.root) throw new Error('当前会话不属于所选项目，请重新选择');
      const row = (await this.cdp.evaluate(helpersCall('agentList()'))).find(a => a.current);
      if (fusionCursorProjects().get(row?.repository)?.id === project?.id) return;
    }
    const current = this.app === 'codex' ? await this.cdp.evaluate(helpersCall('codexCurrentProject()'))
      : windowRoots(await this.editorCdp.evaluate('document.title'), this.app)[0];
    if (!project || fusionProject(current?.root, current?.host || '')?.id !== project.id) throw new Error('当前会话不属于所选项目，请重新选择');
  },
  async fusionDraft() {
    return await this.cdp.evaluate(`(() => {
      const doc = document.getElementById('active-frame')?.contentDocument || document;
      const ed = [...doc.querySelectorAll('.ProseMirror[contenteditable="true"], .aislash-editor-input[contenteditable="true"], .ui-prompt-input-editor__input[contenteditable="true"], [role="textbox"][aria-label="Prompt"]')].find(e => e.getBoundingClientRect().height > 0);
      return (ed?.innerText || '').replace(/[\\u200b\\ufeff]/g, '').trim();
    })()`);
  },
  async fusionPickNativeModel(label, effort = false, targetEffort = '') {
    if (!effort) {
      await this.pressControl('model');
    }
    let pos = null;
    for (let i = 0; i < 10 && !pos; i++) {
      await new Promise(r => setTimeout(r, 150));
      pos = await this.cdp.evaluate(helpersCall(`menuItem('model', ${JSON.stringify(String(label))})`));
      if (!pos && !effort) await this.cdp.evaluate(helpersCall('clickModelListTrigger()'));
    }
    if (!pos) { await this.key('Escape'); throw new Error(`没找到模型：${label}`); }
    await this.tapCss(pos.x, pos.y);
    await new Promise(r => setTimeout(r, 400));
    const options = await this.cdp.evaluate(helpersCall("menuItems('model')"));
    if (!effort && this.app === 'codex' && options.some(it => /^(None|Minimal|Low|Light|Medium|High|Extra High|Max|Ultra|Persistent)$/.test(it.label))) {
      if (targetEffort) return this.fusionPickNativeModel(targetEffort, true);
      return options;
    }
    await this.closeMenus();
    return null;
  },
  async fusionEnsureModel(spec) {
    const wanted = spec.modelLabel ? spec : { ...spec, ...fusionModelSpec(spec.model) };
    const matches = model => {
      const actual = fusionModelSpec(model);
      return actual.modelLabel === wanted.modelLabel && (!wanted.modelEffort || actual.modelEffort === wanted.modelEffort);
    };
    let chat = await this.cdp.evaluate(helpersCall('extract()'));
    if (matches(chat?.model)) return;
    const options = await this.fusionPickNativeModel(wanted.modelLabel, false, wanted.modelEffort);
    if (options) { await this.closeMenus(); throw new Error('先选择该角色的推理强度'); }
    chat = await this.cdp.evaluate(helpersCall('extract()'));
    if (!matches(chat?.model)) throw new Error('模型切换没有生效');
  }
};
