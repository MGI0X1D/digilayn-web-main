const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

admin.initializeApp();

exports.deleteUserFully = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
        "unauthenticated",
        "The function must be called while authenticated."
    );
  }

  const uidToDelete = request.data.uid;
  let usernameToDelete = request.data.username;

  const callerUid = request.auth.uid;

  const callerDoc = await admin
      .firestore()
      .collection("users")
      .doc(callerUid)
      .get();

  const callerData = callerDoc.data();

  if (
      !callerData?.roles?.digilayn?.is_super_user
  ) {
    throw new HttpsError(
        "permission-denied",
        "Only SuperUsers can perform this action."
    );
  }

  if (callerUid === uidToDelete) {
    throw new HttpsError(
        "invalid-argument",
        "You cannot delete yourself."
    );
  }

  try {
    const userDocRef = admin
        .firestore()
        .collection("users")
        .doc(uidToDelete);

    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      throw new HttpsError(
          "not-found",
          "User document not found."
      );
    }

    const userData = userDoc.data();

    if (!usernameToDelete) {
      usernameToDelete = userData.username;
    }

    if (usernameToDelete) {
      await admin
          .firestore()
          .collection("usernames")
          .doc(usernameToDelete)
          .delete();
    }

    await userDocRef.delete();

    await admin.auth().deleteUser(uidToDelete);

    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({
      prefix: `users/${uidToDelete}/`
    });

    let deletedFilesCount = 0;

    if (files.length > 0) {
      await Promise.all(files.map(file => file.delete()));
      deletedFilesCount = files.length;
    }

    return {
      success: true,
      deleted_uid: uidToDelete,
      deleted_username: usernameToDelete || null,
      deleted_storage_files: deletedFilesCount
    };

  } catch (error) {
    console.error(error);

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError(
        "internal",
        error.message || "Delete failed."
    );
  }
});