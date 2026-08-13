/**
 * firebase-config.js — LaynFleet Manager dashboard.
 *
 * Uses the SHARED Digilayn Firebase project (`digilayn-projects`) — the same
 * backend the Android apps (LaynRider / LaynDriver) write to. Web API keys are
 * public identifiers (safe to expose); real access control lives in Firestore
 * security rules. Until those rules are locked down, the manager gate here is
 * enforced client-side by the signed-in email only (dev-grade — see manager.js).
 *
 * This page is intentionally ISOLATED from the rest of web-poortjie: it inits
 * its own Firebase app instance and pulls in no shared scripts.
 */
(function (global) {
  'use strict';

  global.LAYNFLEET_FIREBASE_CONFIG = {
    apiKey: 'AIzaSyANCpYHeLyWkgVtWL06xpI7XsP08xu9GPA',
    authDomain: 'digilayn-projects.firebaseapp.com',
    projectId: 'digilayn-projects',
    storageBucket: 'digilayn-projects.firebasestorage.app',
    messagingSenderId: '95485356681',
    appId: '1:95485356681:web:3cf619a266961009e17458',
    measurementId: 'G-27H9WZSCGQ'
  };

  // Only this account may access the manager dashboard (blueprint: static manager).
  global.MANAGER_EMAIL = 'usrmusa@gmail.com';

  // Firestore layout (must match the Android app — camelCase, app-first).
  global.FS = {
    users: 'users',
    laynfleet: 'laynfleet',
    laynfleetDoc: 'main',
    drivers: 'drivers',
    riders: 'riders',
    bookings: 'bookings',
    adminActions: 'adminActions'
  };

  // Provenance strings written by the apps at registration.
  global.APP_PACKAGES = ['com.digilayn.laynrider', 'com.digilayn.layndriver'];
})(window);
