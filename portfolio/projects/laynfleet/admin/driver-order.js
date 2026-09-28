/* Shared ordering for manager driver lists. Presence eligibility stays with each view. */
(function () {
  'use strict';

  function presenceTime(value) {
    const millis = typeof value === 'number' ? value
      : value && typeof value.toMillis === 'function' ? value.toMillis()
      : value && typeof value.seconds === 'number' ? value.seconds * 1000
      : null;
    return Number.isFinite(millis) && millis > 0 ? millis : 0;
  }

  function lastPresence(driver, location) {
    // Missing timestamps sort last; never infer activity from profile edits.
    return Math.max(presenceTime(driver.lastSeenAt), presenceTime(location && location.locationUpdatedAt));
  }

  function compare(a, b) {
    return Number(b.online) - Number(a.online)
      || b.lastPresence - a.lastPresence
      || String(a.uid).localeCompare(String(b.uid));
  }

  window.LaynFleetDriverOrder = { lastPresence, compare };
})();
