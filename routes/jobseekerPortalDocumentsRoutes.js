const express = require("express");
const { put } = require("@vercel/blob");
const Onboarding = require("../models/onboarding");
const JobseekerPortalAuthController = require("../controllers/jobseekerPortalAuthController");
const Document = require("../models/document");

module.exports = function jobseekerPortalDocumentsRoutes(pool) {
  const router = express.Router();

  const onboarding = new Onboarding(pool);
  const portal = new JobseekerPortalAuthController(pool);
  const documentModel = new Document(pool);

  function getJobSeekerId(req) {
    return req.portalUser?.job_seeker_id || req.user?.job_seeker_id || req.user?.id || null;
  }

  // Route to fetch documents that have been sent to this job seeker via onboarding
  router.get("/documents", portal.portalAuth.bind(portal), async (req, res) => {
    try {
      const jobSeekerId = getJobSeekerId(req);
      if (!jobSeekerId) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }

      const docs = await onboarding.listForJobSeeker(jobSeekerId);

      const docsWithData = await Promise.all(
        docs.map(async (doc) => {
          const data = await onboarding.getJobseekerData(
            jobSeekerId,
            doc.template_document_id
          );
          return { ...doc, jobseekerData: data };
        })
      );

      return res.json({ success: true, documents: docsWithData });
    } catch (e) {
      console.error("[jobseekerPortalDocuments] list", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // Simple profile proxy for portal
  router.get("/profile", portal.portalAuth.bind(portal), async (req, res) => {
    try {
      const jobSeekerId = getJobSeekerId(req);

      if (!jobSeekerId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized - No Jobseeker ID found in request",
        });
      }

      const profile = await onboarding.getJobseekerProfile(jobSeekerId);
      return res.json({ success: true, profile });
    } catch (e) {
      console.error("[jobseekerPortalDocuments] profile", e);
      return res.status(500).json({ success: false, message: "Server error" });
    }
  });

  // Jobseeker signs/submits an onboarding document item (portal auth, no staff token)
  router.post(
    "/documents/:itemId/sign",
    portal.portalAuth.bind(portal),
    async (req, res) => {
      const itemId = Number(req.params.itemId);
      const jobSeekerId = getJobSeekerId(req);

      if (!itemId || !jobSeekerId) {
        return res.status(400).json({
          success: false,
          message: "itemId and portal job seeker required",
        });
      }

      const client = await pool.connect();
      let row;

      try {
        const r = await client.query(
          `
          SELECT
            oi.id AS item_id,
            oi.template_document_id,
            os.job_id,
            os.job_seeker_id,
            js.created_by AS jobseeker_owner_id,
            j.created_by AS job_owner_id,
            j.job_title,
            td.document_name
          FROM onboarding_send_items oi
          JOIN onboarding_sends os ON os.id = oi.onboarding_send_id
          JOIN template_documents td ON td.id = oi.template_document_id
          JOIN job_seekers js ON js.id = os.job_seeker_id
          JOIN jobs j ON j.id = os.job_id
          WHERE oi.id = $1 AND os.job_seeker_id = $2
          `,
          [itemId, jobSeekerId]
        );
        row = r.rows[0];
      } catch (e) {
        client.release();
        console.error("[jobseekerPortalDocuments] sign lookup", e);
        return res.status(500).json({ success: false, message: "Server error" });
      } finally {
        if (!client.released) client.release();
      }

      if (!row) {
        return res.status(404).json({
          success: false,
          message: "Item not found",
        });
      }

      const submittedFieldsRaw = Array.isArray(req.body.submitted_fields)
        ? req.body.submitted_fields
        : [];

      const submittedFields = submittedFieldsRaw
        .map((f) => ({
          field_name: f?.field_name || f?.name || "",
          value: f?.value ?? "",
        }))
        .filter((x) => x.field_name);

      if (!submittedFields.length) {
        return res
          .status(400)
          .json({ success: false, message: "submitted_fields required" });
      }

      const c2 = await pool.connect();
      try {
        await c2.query(
          `
          INSERT INTO onboarding_item_submissions
            (onboarding_item_id, job_seeker_id, template_document_id, submitted_fields, created_at)
          VALUES
            ($1, $2, $3, $4::jsonb, NOW())
          `,
          [
            itemId,
            Number(jobSeekerId),
            Number(row.template_document_id),
            JSON.stringify(submittedFields),
          ]
        );
      } catch (e) {
        console.error("[jobseekerPortalDocuments] sign insert", e);
        c2.release();
        return res.status(500).json({ success: false, message: "Server error" });
      } finally {
        c2.release();
      }

      try {
        await onboarding.applyDynamicFlowBack({
          job_seeker_id: Number(jobSeekerId),
          template_document_id: row.template_document_id,
          submitted_fields: submittedFields,
        });

        const jobTitle = row.job_title || `Job #${row.job_id}`;

        await onboarding.setItemStatus({
          item_id: itemId,
          status: "SUBMITTED",
          setCompletedAt: false,
          clearReminders: false,
        });

        await onboarding.insertJobSeekerNote({
          job_seeker_id: Number(row.job_seeker_id),
          text: `Document submitted: ${row.document_name} (Job: ${jobTitle}). Awaiting admin review.`,
          created_by: null,
          action: "onboarding_submitted",
          about_references: {
            job_id: row.job_id,
            onboarding_item_id: itemId,
          },
        });
      } catch (e) {
        console.error("[jobseekerPortalDocuments] sign flow-back", e);
        return res.status(500).json({ success: false, message: "Server error" });
      }

      return res.json({ success: true, status: "SUBMITTED" });
    }
  );

  // Jobseeker uploads a supporting document (stored in DB + Vercel Blob)
  router.post(
    "/documents/:itemId/upload",
    portal.portalAuth.bind(portal),
    async (req, res) => {
      try {
        const itemId = Number(req.params.itemId);
        const jobSeekerId = getJobSeekerId(req);
        const { document_name, document_type, file } = req.body || {};

        if (!itemId || !jobSeekerId) {
          return res.status(400).json({
            success: false,
            message: "itemId and portal job seeker required",
          });
        }

        if (!file) {
          return res
            .status(400)
            .json({ success: false, message: "File is required" });
        }
        if (!document_name) {
          return res.status(400).json({
            success: false,
            message: "Document name is required",
          });
        }

        const base64Data = typeof file === "string" ? file : file.data;
        const mimeType =
          typeof file === "string"
            ? req.body.mime_type || "application/octet-stream"
            : file.type;
        const originalName =
          typeof file === "string" ? req.body.file_name || "document" : file.name;

        if (!base64Data) {
          return res
            .status(400)
            .json({ success: false, message: "File data is missing" });
        }

        const buffer = Buffer.from(base64Data, "base64");
        const timestamp = Date.now();
        const sanitizedName = String(originalName).replace(
          /[^a-zA-Z0-9.-]/g,
          "_"
        );
        const fileName = `job_seeker_portal/${jobSeekerId}/${timestamp}_${sanitizedName}`;

        const blob = await put(fileName, buffer, {
          access: "public",
          contentType: mimeType,
        });

        const doc = await documentModel.create({
          entity_type: "job_seeker",
          entity_id: Number(jobSeekerId),
          document_name,
          document_type: document_type || "Onboarding Upload",
          content: null,
          file_path: blob.url,
          file_size: buffer.length,
          mime_type: mimeType,
          created_by: null,
          source_template_document_id: null,
        });

        return res.status(201).json({
          success: true,
          message: "Document uploaded successfully",
          document: doc,
        });
      } catch (e) {
        console.error("[jobseekerPortalDocuments] upload", e);
        return res.status(500).json({
          success: false,
          message: "An error occurred while uploading the document",
        });
      }
    }
  );

  return router;
};