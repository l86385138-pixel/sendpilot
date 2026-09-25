const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineJsonSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();
const WHATSAPP_CONFIG = defineJsonSecret("WHATSAPP_CONFIG");
const BATCH_SIZE = 25;

function cleanPhone(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

async function claimQueuedMessage(ref, uid) {
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.userId !== uid || data.status !== "queued") return null;
    tx.update(ref, {
      status: "processing",
      processingAt: FieldValue.serverTimestamp()
    });
    return { id: snap.id, ...data };
  });
}

async function sendText(config, phone, body) {
  const version = config.apiVersion || config.graphVersion || "v23.0";
  const url = `https://graph.facebook.com/${version}/${config.phoneNumberId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "text",
      text: { preview_url: false, body }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      data?.error?.error_user_msg ||
      `WhatsApp API HTTP ${response.status}`
    );
  }
  return data;
}

exports.sendWhatsAppBatch = onCall(
  {
    region: "asia-south1",
    timeoutSeconds: 540,
    memory: "256MiB",
    secrets: [WHATSAPP_CONFIG]
  },
  async request => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Please sign in.");
    }

    const { campaignId } = request.data || {};
    if (!campaignId) {
      throw new HttpsError("invalid-argument", "campaignId is required.");
    }

    const uid = request.auth.uid;
    const campaignRef = db.collection("campaigns").doc(campaignId);
    const campaignSnap = await campaignRef.get();

    if (!campaignSnap.exists || campaignSnap.data().userId !== uid) {
      throw new HttpsError("permission-denied", "Campaign not found.");
    }

    const campaign = campaignSnap.data();
    if (campaign.optInConfirmed !== true) {
      throw new HttpsError(
        "failed-precondition",
        "Confirm that the selected contacts have WhatsApp opt-in."
      );
    }

    const config = WHATSAPP_CONFIG.value();
    if (!config?.accessToken || !config?.phoneNumberId) {
      throw new HttpsError(
        "failed-precondition",
        "WhatsApp backend is not configured. Set WHATSAPP_CONFIG."
      );
    }

    const queued = await db.collection("messages")
      .where("campaignId", "==", campaignId)
      .where("userId", "==", uid)
      .where("status", "==", "queued")
      .limit(BATCH_SIZE)
      .get();

    if (queued.empty) {
      await campaignRef.update({
        status: "completed",
        completedAt: FieldValue.serverTimestamp()
      });
      return { done: true, processed: 0, sent: 0, failed: 0, remaining: 0 };
    }

    let sent = 0;
    let failed = 0;

    for (const queuedDoc of queued.docs) {
      const msg = await claimQueuedMessage(queuedDoc.ref, uid);
      if (!msg) continue;

      try {
        const contactSnap = await db.collection("contacts").doc(msg.contactId).get();
        const contact = contactSnap.exists ? contactSnap.data() : null;

        if (!contact || contact.userId !== uid) {
          throw new Error("Contact not found.");
        }
        if (contact.optIn !== true) {
          throw new Error("Contact is not marked as opted-in.");
        }

        const phone = cleanPhone(msg.phone || contact.phone);
        if (!phone) throw new Error("Contact has no valid phone number.");

        const apiResult = await sendText(config, phone, msg.message);

        await queuedDoc.ref.update({
          status: "sent",
          sentAt: FieldValue.serverTimestamp(),
          whatsappMessageId: apiResult?.messages?.[0]?.id || null
        });
        sent++;
      } catch (error) {
        await queuedDoc.ref.update({
          status: "failed",
          failedAt: FieldValue.serverTimestamp(),
          error: String(error.message || error).slice(0, 1000)
        });
        failed++;
      }

      await new Promise(resolve => setTimeout(resolve, 250));
    }

    const remainingSnap = await db.collection("messages")
      .where("campaignId", "==", campaignId)
      .where("userId", "==", uid)
      .where("status", "==", "queued")
      .limit(1)
      .get();

    const remaining = remainingSnap.size > 0;

    await campaignRef.update({
      status: remaining ? "sending" : "completed",
      sentCount: FieldValue.increment(sent),
      failedCount: FieldValue.increment(failed),
      lastRunAt: FieldValue.serverTimestamp(),
      ...(remaining ? {} : { completedAt: FieldValue.serverTimestamp() })
    });

    return {
      done: !remaining,
      processed: sent + failed,
      sent,
      failed,
      remaining: remaining ? 1 : 0
    };
  }
);
