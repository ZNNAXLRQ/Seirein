/** Settings actions for persona/profile editing, organization and reference quizzes. */
import { profileCategoryAction } from './profile-actions.js';
import { profileEntryAction } from './profile-actions.js';
import { profileReclassifyApply } from './profile-actions.js';
import { profileReclassifyPreview } from './profile-actions.js';

export const ACTIONS = Object.freeze([
  'persona.get',
  'persona.set',
  'profile.capacity',
  'profile.list',
  'profile.edit',
  'profile.lock',
  'profile.reject',
  'profile.remove',
  'profile.revision',
  'profile.revert',
  'profile.import',
  'profile.maintain.now',
  'profile.maintain.cancel',
  'profile.reclassify.preview',
  'profile.reclassify.apply',
  'profile.category.list',
  'profile.category.create',
  'profile.category.rename',
  'profile.category.merge',
  'profile.category.delete',
  'profile.entry.list',
  'profile.entry.update',
  'profile.entry.setCategory',
  'profile.entry.delete',
  'profile.save',
  'profile.reconcile',
  'persona.quiz.start',
  'persona.quiz.generate',
  'persona.quiz.applyTrial',
  'persona.quiz.edit',
  'persona.quiz.adopt',
  'persona.quiz.discard',
  'profile.auto',
]);

export function createProfileSettingsActions(services) {
  const handler = async (body) => {
    switch (body.action) {
      case 'persona.get':
        return { ok: true, agent: services.persona.read('agent'), user: services.persona.read('user') };
      case 'persona.set': {
        if (body.which !== 'agent' && body.which !== 'user') return { ok: false, error: 'unknown profile' };
        services.persona.write(body.which, typeof body.text === 'string' ? body.text : '');
        await services.log.emit('persona.write', { which: body.which, source: 'settings' });
        // A persona edit changes the effective text: rebuild the style off the request path.
        (0, services.scheduleAvatarStyleRefresh)();
        return { ok: true };
      }
      case 'profile.capacity':
        return (0, services.profileAction)(() => (0, services.profile)().capacity());
      case 'profile.list':
        return (0, services.profileAction)(() => {
          const library = (0, services.profile)();
          // Enforce/count first: an over-cap table must not report entries it is about to delete.
          const capacity = library.capacity();
          return {
            entries: library.list({
              side: typeof body.side === 'string' && body.side.length > 0 ? body.side : undefined,
              category: typeof body.category === 'string' && body.category.length > 0 ? body.category : undefined,
              rank: typeof body.rank === 'string' && body.rank.length > 0 ? body.rank : undefined,
            }),
            capacity,
          };
        });
      case 'profile.edit':
        return (0, services.profileAction)(() => {
          const maintainer = (0, services.maintainProfile)();
          let result = null;
          (0, services.profile)().transact(() => {
            result = (0, services.profile)().edit(String(body.id ?? ''), body.patch ?? {}, { source: 'user' });
            // Same transaction: the next request already reads the recompiled snapshot.
            if (result !== null && result.changed.length > 0) maintainer.compileNow({ trigger: 'edit' });
          });
          if (result === null) return { ok: false, error: 'profile entry not found' };
          void services.log.emit('profile.edit', { id: result.entry.id, fields: result.changed, source: 'settings' }).catch(() => {});
          return { entry: result.entry, changed: result.changed, revision: result.revision };
        });
      case 'profile.lock':
        return (0, services.profileAction)(() => {
          const entry = (0, services.profile)().lock(String(body.id ?? ''), body.on !== false);
          return entry === null ? { ok: false, error: 'profile entry not found' } : { entry };
        });
      case 'profile.reject':
        return (0, services.profileAction)(() => {
          const maintainer = (0, services.maintainProfile)();
          let removed = false;
          (0, services.profile)().transact(() => {
            removed = (0, services.profile)().reject(String(body.id ?? ''));
            if (removed) maintainer.compileNow({ trigger: 'reject' });
          });
          if (removed) void services.log.emit('profile.reject', { id: body.id, source: 'settings' }).catch(() => {});
          return { removed };
        });
      case 'profile.remove':
        return (0, services.profileAction)(() => {
          const maintainer = (0, services.maintainProfile)();
          return (0, services.profile)().transact(() => {
            // Boundary first: a message read after this delete must not rebuild the tendency.
            maintainer.recordDeletion(String(body.id ?? ''));
            const removed = (0, services.profile)().remove(String(body.id ?? ''));
            if (removed) maintainer.compileNow({ trigger: 'remove' });
            return { removed };
          });
        });
      case 'profile.revision':
        return (0, services.profileAction)(() => ({ revisions: (0, services.profile)().revision(String(body.id ?? '')) }));
      case 'profile.revert':
        return (0, services.profileAction)(() => {
          const maintainer = (0, services.maintainProfile)();
          let result = null;
          (0, services.profile)().transact(() => {
            result = (0, services.profile)().revert(String(body.revisionId ?? ''));
            if (result !== null && result.changed.length > 0) maintainer.compileNow({ trigger: 'revert' });
          });
          if (result === null) return { ok: false, error: 'profile revision not found' };
          void services.log.emit('profile.revert', { id: result.entry.id, fields: result.changed, source: 'settings' }).catch(() => {});
          return { entry: result.entry, changed: result.changed };
        });
      case 'profile.import':
        return (0, services.profileAction)(() => {
          const result = (0, services.profile)().importText({
            side: body.side,
            text: typeof body.text === 'string' ? body.text : '',
            items: Array.isArray(body.items) ? body.items : [],
          });
          void services.log.emit('profile.import', {
            side: result.side,
            imported: result.imported.length,
            skipped: result.skipped.length,
            source: 'settings',
          }).catch(() => {});
          return result;
        });
      case 'profile.maintain.now':
        // Settings-page「立刻整理」: the card sends its current two texts. Persist them first (the
        // box is the authoritative prompt), then run the COMPLETE organize round: split → library
        // → compile → rewrite → write back → save. A pending box is never imported by the schedule.
        return (0, services.profileAction)(async () => {
          const maintainer = (0, services.maintainProfile)();
          // The single queue slot is checked before persisting/splitting the boxes: a second
          // click must not become a second split task, even if it raced the disabled button.
          if (maintainer.status().queued === true) {
            return { ok: false, status: 'rejected', reason: 'queue-full' };
          }
          const agent = typeof body.agent === 'string' ? body.agent : undefined;
          const user = typeof body.user === 'string' ? body.user : undefined;
          const fromCard = agent !== undefined || user !== undefined;
          if (agent !== undefined) services.persona.write('agent', agent);
          if (user !== undefined) services.persona.write('user', user);
          if (fromCard) maintainer.markBoxesAuthoritative();
          // 试用期间整理结果不回写文本框：试用文本是当前注入内容，只有「正式采用」才结束试用。
          const trialing = maintainer.personaTrialState().active === true;
          return maintainer.now({
            trigger: 'settings',
            expectedVersion: body.version ?? null,
            writeBack: fromCard && trialing !== true,
            full: trialing !== true,
          });
        });
      case 'profile.maintain.cancel':
        // 取消一个还在排队的整理请求；正在执行的那一个会被 abort，并沿原路径返回 cancelled。
        return (0, services.profileAction)(() => (0, services.maintainProfile)().cancel(body.taskId));
      case 'profile.reclassify.preview':
        return (0, services.profileAction)(() => profileReclassifyPreview((0, services.maintainProfile)()));
      case 'profile.reclassify.apply':
        return (0, services.profileAction)(() => profileReclassifyApply((0, services.maintainProfile)(), body));
      case 'profile.category.list':
      case 'profile.category.create':
      case 'profile.category.rename':
      case 'profile.category.merge':
      case 'profile.category.delete':
        return (0, services.profileAction)(() => profileCategoryAction(
          (0, services.maintainProfile)(),
          body.action.slice('profile.category.'.length),
          body,
        ));
      case 'profile.entry.list':
      case 'profile.entry.update':
      case 'profile.entry.setCategory':
      case 'profile.entry.delete':
        return (0, services.profileAction)(() => profileEntryAction(
          (0, services.maintainProfile)(),
          body.action.slice('profile.entry.'.length),
          body,
        ));
      case 'profile.save':
        // 「保存」只写入文本框并标记未入库：不拆分、不改库、不重写。注入立即使用这段文本。
        return (0, services.profileAction)(() => (0, services.maintainProfile)().save({
          agent: typeof body.agent === 'string' ? body.agent : undefined,
          user: typeof body.user === 'string' ? body.user : undefined,
          trigger: 'settings',
        }));
      case 'profile.reconcile':
        // 「设置框」里的提示词编辑：只做行级差异核对（新增/修改/删除），不重交模型拆解、不产生证据。
        return (0, services.profileAction)(() => (0, services.maintainProfile)().reconcile({
          agent: typeof body.agent === 'string' ? body.agent : undefined,
          user: typeof body.user === 'string' ? body.user : undefined,
          trigger: 'settings',
          expectedVersion: body.version ?? null,
        }));
      case 'persona.quiz.start':
        return (0, services.profileAction)(() => (0, services.maintainProfile)().startPersonaQuiz());
      case 'persona.quiz.generate':
        return (0, services.profileAction)(() => (0, services.maintainProfile)().generatePersonaQuiz({
          answers: Array.isArray(body.answers) ? body.answers : [],
          revision: body.revision ?? null,
        }));
      case 'persona.quiz.applyTrial':
        return (0, services.profileAction)(() => (0, services.maintainProfile)().applyPersonaQuizTrial({
          text: typeof body.text === 'string' ? body.text : null,
          revision: body.revision ?? null,
        }));
      case 'persona.quiz.edit':
        // 试用期间的普通文本编辑：只更新当前注入的人设，不拆分、不入库、不产生证据。
        return (0, services.profileAction)(() => (0, services.maintainProfile)().updatePersonaQuizTrialText({
          text: typeof body.text === 'string' ? body.text : '',
        }));
      case 'persona.quiz.adopt':
        return (0, services.profileAction)(() => (0, services.maintainProfile)().adoptPersonaQuizTrial({
          text: typeof body.text === 'string' ? body.text : null,
        }));
      case 'persona.quiz.discard':
        return (0, services.profileAction)(() => (0, services.maintainProfile)().discardPersonaQuizTrial());
      case 'profile.auto': {
        // 「暂停自动整理」: persist the switch and arm/disarm the 7-day timer immediately.
        const enabled = body.autoMaintain !== false;
        const stored = (0, services.readSettings)().profile;
        (0, services.writeSettings)({
          profile: { ...(stored !== null && typeof stored === 'object' ? stored : {}), autoMaintain: enabled },
        });
        if (enabled) (0, services.maintainProfile)().start({ runOnStart: false });
        else services.profileMaintainer?.dispose();
        await services.log.emit('profile.auto', { autoMaintain: enabled, source: 'settings' });
        return { ok: true, autoMaintain: enabled };
      }
  }
};
  return handler;
}
