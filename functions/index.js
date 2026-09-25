const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineJsonSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const WHATSAPP_CONFIG = defineJsonSecret("WHATSAPP_CONFIG");

exports.sendCampaign = onCall(
  {
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "512MiB",
    secrets: [WHATSAPP_CONFIG]
  },
  async (request) => {
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
    if (campaign.status === "sending") {
      throw new HttpsError("already-exists", "Campaign is already sending.");
    }

    const config = WHATSAPP_CONFIG.value();
    const accessToken = config.accessToken;
    const phoneNumberId = config.phoneNumberId;
    const graphVersion = config.graphVersion;

    if (!accessToken || !phoneNumberId || !graphVersion) {
      throw new HttpsError("failed-precondition", "WhatsApp backend is not configured.");
    }

    await campaignRef.update({
      status: "sending",
      startedAt: FieldValue.serverTimestamp(),
      error: null
    });

    const messagesSnap = await db.collection("messages")
      .where("campaignId", "==", campaignId)
      .where("userId", "==", uid)
      .where("status", "==", "queued")
      .limit(1000)
      .get();

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const doc of messagesSnap.docs) {
      const msg = doc.data();

      // Safety gate: only send contacts explicitly marked as opted-in.
      if (msg.optIn !== true) {
        await doc.ref.update({
          status: "blocked",
          error: "Contact has no explicit WhatsApp opt-in.",
          updatedAt: FieldValue.serverTimestamp()
        });
        failed++;
        continue;
      }

      try {
        const response = await fetch(
          `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: String(msg.phone).replace(/\\D/g, ""),
              type: "text",
              text: { preview_url: false, body: msg.message }
            })
          }
        );

        const body = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(body?.error?.message || `WhatsApp API HTTP ${response.status}`);
        }

        const waMessageId = body?.messages?.[0]?.id || null;
        await doc.ref.update({
          status: "sent",
          whatsappMessageId: waMessageId,
          sentAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        });
        sent++;
      } catch (err) {
        await doc.ref.update({
          status: "failed",
          error: String(err.message || err).slice(0, 500),
          updatedAt: FieldValue.serverTimestamp()
        });
        failed++;
        if (errors.length < 10) errors.push(String(err.message || err));
      }
    }

    const finalStatus = failed === 0 ? "sent" : (sent > 0 ? "partial" : "failed");
    await campaignRef.update({
      status: finalStatus,
      sentCount: String(sent),
      failedCount: String(failed),
      finishedAt: FieldValue.serverTimestamp()
    });

    return {
      campaignId,
      status: finalStatus,
      sent,
      failed,
      errors
    };
  }
);