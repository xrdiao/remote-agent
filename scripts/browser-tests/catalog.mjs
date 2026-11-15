import connection from './blocks/connection.mjs';
import overview from './blocks/overview.mjs';
import sessions from './blocks/sessions.mjs';
import composer from './blocks/composer.mjs';
import conversation from './blocks/conversation.mjs';
import models from './blocks/models.mjs';
import questions from './blocks/questions.mjs';
import files from './blocks/files.mjs';
import terminal from './blocks/terminal.mjs';
import fusion from './blocks/fusion.mjs';
import client from './blocks/client.mjs';
import stress from './blocks/stress.mjs';
import execution from './blocks/execution.mjs';

export const apps = ['codex', 'cursor', 'devin', 'opencode'];
export const blocks = { connection, overview, sessions, composer, execution, conversation, models, questions, files, terminal, fusion, client, stress };
export const catalog = Object.entries(blocks).flatMap(([block, cases]) => cases.map(test => ({ ...test, block })));

export function plan(options) {
  return catalog.filter(test => (!options.blocks.length || options.blocks.includes(test.block))
    && (!options.cases.length || options.cases.includes(test.id)))
    .flatMap(test => (test.apps ? (test.apps === true ? apps : test.apps).filter(app => options.apps.includes(app)) : [null])
      .map(app => ({ ...test, app })));
}
export function enabled(test, suite) {
  return suite === 'stress' ? test.mode === 'stress' : suite === 'full' ? !['stress', 'manual'].includes(test.mode)
    : suite === 'workflow' ? ['read', 'write'].includes(test.mode) : test.mode === 'read';
}
