/* Rider notices: real Firestore data, server-authenticated writes, no seeded content. */
(function () {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const types = { NEWS: 'News', INFORMATION: 'Information', WARNING: 'Warning', PROMOTION: 'Promotion' };
  let notices = [];
  let editingId = null;
  let editingVersion = 0;
  let ready = false;
  let saving = false;
  let connectionGeneration = 0;
  const form = byId('notice-form');
  const list = byId('notice-list');
  const status = byId('notice-status');

  function message(text, error = false) {
    status.textContent = text;
    status.classList.toggle('notice-error', error);
  }
  function setSaveEnabled() {
    Array.from(form.elements).forEach((element) => { element.disabled = saving; });
    byId('notice-new').disabled = saving;
    byId('notice-save').disabled = !ready || saving;
  }
  function resetEditor() {
    form.reset();
    editingId = null;
    editingVersion = 0;
    byId('notice-editor-title').textContent = 'New notice';
    setSaveEnabled();
  }
  function isValid(record) {
    return Object.hasOwn(types, record.type) && typeof record.title === 'string' && record.title.trim().length > 0 &&
      record.title.trim().length <= 120 && (record.message === null || typeof record.message === 'string' && record.message.length <= 2000) &&
      typeof record.enabled === 'boolean' && typeof record.dismissible === 'boolean' &&
      Number.isSafeInteger(record.sortOrder) && record.sortOrder >= 0 && record.sortOrder <= 10000 &&
      Number.isSafeInteger(record.version) && record.version > 0 && record.version <= 2147483647 &&
      [record.startsAt, record.endsAt].every((date) => date === null || Number.isSafeInteger(date) && date >= 0) &&
      (record.startsAt === null || record.endsAt === null || record.endsAt > record.startsAt);
  }
  function localDate(value) { return value === null ? '' : new Date(value + 7200000).toISOString().slice(0, 16); }
  function timestamp(value) {
    if (!value) return null;
    const result = Date.parse(value + '+02:00');
    if (!Number.isSafeInteger(result)) throw new Error('Choose a valid SAST date and time.');
    return result;
  }
  function formatDate(value) {
    return new Intl.DateTimeFormat('en-ZA', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Johannesburg' }).format(value);
  }
  function visibility(record) {
    const now = Date.now();
    if (!record.enabled) return 'Hidden';
    if (record.message === null || !record.message.trim()) return 'No message — hidden';
    if (record.startsAt !== null && now < record.startsAt) return 'Scheduled';
    if (record.endsAt !== null && now >= record.endsAt) return 'Expired';
    return 'Visible';
  }
  function edit(record) {
    editingId = record.id;
    editingVersion = record.version;
    byId('notice-editor-title').textContent = 'Edit notice · version ' + record.version;
    for (const field of ['type', 'title', 'sortOrder']) byId('notice-' + field.replace('sortOrder', 'order')).value = record[field];
    byId('notice-message').value = record.message === null ? '' : record.message;
    byId('notice-enabled').checked = record.enabled;
    byId('notice-dismissible').checked = record.dismissible;
    byId('notice-start').value = localDate(record.startsAt);
    byId('notice-end').value = localDate(record.endsAt);
    message('Saving creates a new version. Riders who dismissed an older version will see the revision.');
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function render() {
    list.replaceChildren();
    if (!ready) return;
    if (!notices.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No notices yet. Create one using the editor.';
      list.append(empty);
    }
    notices.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)).forEach((record) => {
      const card = document.createElement('article');
      card.className = 'notice-admin-card';
      if (!isValid(record)) {
        card.textContent = 'Notice ' + record.id + ' has invalid or missing fields. Correct its Firestore data before editing.';
        list.append(card);
        return;
      }
      const heading = document.createElement('h3'); heading.textContent = record.title;
      const badge = document.createElement('p'); badge.className = 'notice-meta';
      badge.textContent = types[record.type] + ' · ' + visibility(record) + ' · Order ' + record.sortOrder + ' · Version ' + record.version +
        ' · ' + (record.dismissible ? 'Dismissible' : 'Cannot be dismissed');
      const body = document.createElement('p'); body.className = 'notice-body'; body.textContent = record.message === null ? '' : record.message;
      const dates = document.createElement('p'); dates.className = 'notice-meta';
      dates.textContent = 'Start: ' + (record.startsAt === null ? 'Immediately' : formatDate(record.startsAt) + ' SAST') +
        ' · End: ' + (record.endsAt === null ? 'Until hidden' : formatDate(record.endsAt) + ' SAST');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-sm';
      button.textContent = 'Edit / change visibility'; button.disabled = saving; button.addEventListener('click', () => edit(record));
      card.append(heading, badge, body, dates, button); list.append(card);
    });
  }
  byId('notice-new').addEventListener('click', () => { if (!saving) { resetEditor(); message(''); } });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!ready || saving) return;
    const currentGeneration = connectionGeneration;
    saving = true; setSaveEnabled(); render();
    try {
      const payload = {
        noticeId: editingId, expectedVersion: editingVersion,
        type: byId('notice-type').value, title: byId('notice-title').value.trim(), message: byId('notice-message').value.trim(),
        enabled: byId('notice-enabled').checked, dismissible: byId('notice-dismissible').checked,
        sortOrder: Number(byId('notice-order').value), startsAt: timestamp(byId('notice-start').value), endsAt: timestamp(byId('notice-end').value)
      };
      if (payload.startsAt !== null && payload.endsAt !== null && payload.endsAt <= payload.startsAt) throw new Error('End must be after start.');
      const response = await firebase.app().functions('us-central1').httpsCallable('managerSaveDashboardNotice')(payload);
      if (!response.data || !response.data.noticeId || !Number.isSafeInteger(response.data.version)) throw new Error('Save was not confirmed.');
      if (currentGeneration !== connectionGeneration) return;
      resetEditor();
      message('Saved version ' + response.data.version + (payload.enabled ? '. It appears during its date window when its message is nonblank.' : '. This notice is hidden.'));
    } catch (error) {
      if (currentGeneration === connectionGeneration) message(error.message || 'Could not save the notice.', true);
    } finally {
      if (currentGeneration === connectionGeneration) { saving = false; setSaveEnabled(); render(); }
    }
  });
  // manager.js owns session lifetime and registers this listener for logout cleanup.
  window.LaynFleetNotices = {
    attach(db) {
      connectionGeneration += 1;
      const generation = connectionGeneration;
      ready = false; saving = false; notices = []; resetEditor(); render(); message('Loading notices…');
      const unsubscribe = db.collection('laynfleet').doc('main').collection('dashboardNotices')
        .onSnapshot({ includeMetadataChanges: true }, (snapshot) => {
          if (generation !== connectionGeneration) return;
          if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) {
            ready = false; notices = []; setSaveEnabled(); render(); message('Waiting for verified notice data…'); return;
          }
          notices = snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
          ready = true; setSaveEnabled(); render();
          if (status.textContent.startsWith('Loading') || status.textContent.startsWith('Waiting')) message('');
        }, (error) => {
          ready = false; notices = []; setSaveEnabled(); render(); message('Could not load notices: ' + error.message, true);
        });
      const timer = setInterval(render, 30000);
      return () => {
        connectionGeneration += 1; unsubscribe(); clearInterval(timer);
        ready = false; saving = false; notices = []; resetEditor(); render(); message('');
      };
    }
  };
})();
