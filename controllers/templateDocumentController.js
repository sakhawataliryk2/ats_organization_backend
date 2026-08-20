const TemplateDocument = require("../models/templateDocument");
const { put } = require("@vercel/blob");


class TemplateDocumentController {
  constructor(pool) {
    this.pool = pool;
    this.model = new TemplateDocument(pool);

    this.getAll = this.getAll.bind(this);
    this.getById = this.getById.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.delete = this.delete.bind(this);
    this.getMappings = this.getMappings.bind(this);
    this.saveMappings = this.saveMappings.bind(this);

    this.getInternalUsers = this.getInternalUsers.bind(this);
    this.archive = this.archive.bind(this);
  }

  async initTables() {
    await this.model.initTable();
  }
  async getAll(req, res) {
    let client;
    try {
      const archived =
        req.query.archived === "1" ||
        req.query.archived === "true" ||
        req.query.archived === 1;

      client = await this.model.pool.connect();

      const q = `
      SELECT 
        td.*, 
        u.name AS created_by_name,
        COALESCE(COUNT(m.id), 0)::int AS mapped_count
      FROM template_documents td
      LEFT JOIN users u ON u.id = td.created_by
      LEFT JOIN template_document_mappings m 
        ON m.template_document_id = td.id
      WHERE td.status = TRUE
        AND td.is_archived = $1
      GROUP BY td.id, u.name
      ORDER BY td.created_at DESC
    `;

      const r = await client.query(q, [archived]);
      return res.json({ success: true, documents: r.rows });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch template documents",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    } finally {
      if (client) client.release();
    }
  }

  async getById(req, res) {
    try {
      const doc = await this.model.getById(req.params.id);
      if (!doc)
        return res.status(404).json({ success: false, message: "Not found" });
      return res.json({ success: true, document: doc });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch template document",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }

  async create(req, res) {
    try {
      const userId = req.user?.id || null;

      // Support JSON body with base64 file (same pattern as organization/jobs upload)
      const fileFromBody = req.body.file || null;
      let file = null;
      if (fileFromBody && fileFromBody.data) {
        const buffer = Buffer.from(fileFromBody.data, "base64");
        file = {
          originalname: fileFromBody.name || "document.pdf",
          mimetype: fileFromBody.type || "application/pdf",
          buffer,
          size: buffer.length,
        };
      }

      const notification_user_ids = req.body.notification_user_ids
        ? (typeof req.body.notification_user_ids === "string"
            ? JSON.parse(req.body.notification_user_ids)
            : req.body.notification_user_ids)
        : [];

      let file_url = null;
      if (file) {
        const safeName = (file.originalname || "document.pdf").replace(
          /\s+/g,
          "_"
        );
        const blob = await put(
          `template-documents/${Date.now()}_${safeName}`,
          file.buffer,
          { access: "public", contentType: file.mimetype }
        );
        file_url = blob.url;
      }

      const doc = await this.model.create({
        document_name: req.body.document_name,
        category: req.body.category,
        description: req.body.description,

        approval_required:
          req.body.approvalRequired === "Yes" ||
          req.body.approval_required === "true",

        additional_docs_required:
          req.body.additionalDocsRequired === "Yes" ||
          req.body.additional_docs_required === "true",

        file_name: file?.originalname || null,
        file_path: null, // ✅ no local uploads on Vercel
        file_url, // ✅ store blob url
        file_size: file?.size || null,
        mime_type: file?.mimetype || null,

        notification_user_ids,
        created_by: userId,
      });

      return res.status(201).json({
        success: true,
        message: "Template document created",
        document: doc,
      });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to create template document",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }

  async update(req, res) {
    try {
      const id = req.params.id;

      // Support JSON body with base64 file (same pattern as organization/jobs upload)
      const fileFromBody = req.body.file || null;
      let file = null;
      if (fileFromBody && fileFromBody.data) {
        const buffer = Buffer.from(fileFromBody.data, "base64");
        file = {
          originalname: fileFromBody.name || "document.pdf",
          mimetype: fileFromBody.type || "application/pdf",
          buffer,
          size: buffer.length,
        };
      }

      const notification_user_ids =
        req.body.notification_user_ids !== undefined
          ? (typeof req.body.notification_user_ids === "string"
              ? JSON.parse(req.body.notification_user_ids)
              : req.body.notification_user_ids)
          : undefined;

      let file_url = null;
      if (file) {
        const safeName = (file.originalname || "document.pdf").replace(
          /\s+/g,
          "_"
        );
        const blob = await put(
          `template-documents/${Date.now()}_${safeName}`,
          file.buffer,
          { access: "public", contentType: file.mimetype }
        );
        file_url = blob.url;
      }

      const updated = await this.model.update(id, {
        document_name: req.body.document_name,
        category: req.body.category,
        description: req.body.description,

        approval_required: req.body.approvalRequired
          ? req.body.approvalRequired === "Yes"
          : undefined,

        additional_docs_required: req.body.additionalDocsRequired
          ? req.body.additionalDocsRequired === "Yes"
          : undefined,

        ...(file
          ? {
              file_name: file.originalname,
              file_path: null,
              file_url, // ✅ new url
              file_size: file.size,
              mime_type: file.mimetype,
            }
          : {}),

        notification_user_ids,
      });

      return res.json({ success: true, document: updated });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to update template document",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }

  async delete(req, res) {
    try {
      const deleted = await this.model.softDelete(req.params.id);
      if (!deleted)
        return res.status(404).json({ success: false, message: "Not found" });
      return res.json({ success: true, message: "Deleted", document: deleted });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to delete template document",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }
  async archive(req, res) {
    try {
      const id = req.params.id;
      const archive = req.body?.archive !== false; // default true

      const updated = await this.model.setArchive(id, archive);
      if (!updated)
        return res.status(404).json({ success: false, message: "Not found" });

      return res.json({
        success: true,
        message: archive ? "Archived" : "Unarchived",
        document: updated,
      });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to archive template document",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }

  // dropdown users (active + admin/team/office)
  async getInternalUsers(req, res) {
    let client;
    try {
      client = await this.model.pool.connect();

      const q = `
        SELECT id, name, email, status, is_admin, team_name, office_name
        FROM users
        WHERE status = TRUE
          AND (is_admin = TRUE OR team_name IS NOT NULL OR office_name IS NOT NULL)
        ORDER BY name ASC
      `;
      const r = await client.query(q);

      return res.json({ success: true, users: r.rows });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch users",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    } finally {
      if (client) client.release();
    }
  }
  async getMappings(req, res) {
    try {
      const docId = req.params.id;

      const doc = await this.model.getById(docId);
      if (!doc)
        return res.status(404).json({ success: false, message: "Not found" });

      const fields = await this.model.getMappings(docId);
      return res.json({ success: true, fields });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch mappings",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }
  async saveMappings(req, res) {
    try {
      const docId = req.params.id;

      const doc = await this.model.getById(docId);
      if (!doc)
        return res.status(404).json({ success: false, message: "Not found" });

      const incoming = Array.isArray(req.body.fields) ? req.body.fields : [];

      const fields = incoming.map((f, idx) => ({
        field_id: f.field_id ?? null,
        field_name: f.field_name ?? f.source_field_name ?? null,
        field_label: f.field_label ?? f.source_field_label ?? null,

        field_type: f.field_type ?? f.fieldType ?? "Text Input",
        who_fills: f.who_fills ?? f.whoFills ?? "Candidate",
        is_required: f.is_required ?? f.required === "Yes" ?? false,
        max_characters: f.max_characters ?? f.maxChars ?? 255,
        format: f.format ?? "None",
        populate_with_data:
          f.populate_with_data ?? f.populateWithData === "Yes" ?? false,
        data_flow_back: f.data_flow_back ?? f.dataFlowBack === "Yes" ?? false,
        sort_order: f.sort_order ?? idx,

        x: Number.isFinite(Number(f.x)) ? Number(f.x) : 0,
        y: Number.isFinite(Number(f.y)) ? Number(f.y) : 0,
        w: Number.isFinite(Number(f.w)) ? Number(f.w) : 220,
        h: Number.isFinite(Number(f.h)) ? Number(f.h) : 44,
      }));

      await this.model.replaceMappings(docId, fields);

      return res.json({ success: true, message: "Mappings saved" });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to save mappings",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }
}

module.exports = TemplateDocumentController;
