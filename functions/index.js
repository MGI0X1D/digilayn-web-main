const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

/**
 * deleteUserFully
 * Admin-only callable function to delete a user and all their related data.
 */
exports.deleteUserFully = functions.https.onCall(async (data, context) => {
  // 1. Verify caller is authenticated
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
  }

  const uidToDelete = data.uid;
  let usernameToDelete = data.username;

  // 2. Verify caller is admin
  // We check the roles.digilayn.is_super_user field in the caller's Firestore document
  const callerUid = context.auth.uid;
  const callerDoc = await admin.firestore().collection('users').doc(callerUid).get();
  const callerData = callerDoc.data();

  if (!callerData || !callerData.roles || !callerData.roles.digilayn || callerData.roles.digilayn.is_super_user !== true) {
    throw new functions.https.HttpsError('permission-denied', 'Only SuperUsers can perform this action.');
  }

  // 3. Refuse if caller tries to delete themselves
  if (callerUid === uidToDelete) {
    throw new functions.https.HttpsError('invalid-argument', 'You cannot delete yourself.');
  }

  try {
    // 4. Read user document from users/{uid}
    const userDocRef = admin.firestore().collection('users').doc(uidToDelete);
    const userDoc = await userDocRef.get();
    
    if (!userDoc.exists) {
      throw new functions.https.HttpsError('not-found', 'User document not found.');
    }

    const userData = userDoc.data();

    // 5. Resolve username from input or user document
    if (!usernameToDelete) {
      usernameToDelete = userData.username;
    }

    // 6. Delete username document if username exists: usernames/{username}
    if (usernameToDelete) {
      await admin.firestore().collection('usernames').doc(usernameToDelete).delete();
    }

    // 7. Delete Firestore user document
    await userDocRef.delete();

    // 8. Delete Firebase Auth user
    await admin.auth().deleteUser(uidToDelete);

    // 9. Delete Firebase Storage files under the user paths: users/{uid}/
    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({ prefix: `users/${uidToDelete}/` });
    
    let deletedFilesCount = 0;
    if (files.length > 0) {
      // Delete all files in the user's folder
      await Promise.all(files.map(file => file.delete()));
      deletedFilesCount = files.length;
    }

    // 10. Return a clean result
    return {
      success: true,
      deleted_uid: uidToDelete,
      deleted_username: usernameToDelete || null,
      deleted_storage_files: deletedFilesCount
    };

  } catch (error) {
    console.error('Error deleting user:', error);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throw new functions.https.HttpsError('internal', error.message || 'An error occurred while deleting the user.');
  }
});
