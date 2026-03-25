const OrganizationDefaultDocument = require("../models/organizationDefaultDocument");
const Document = require("../models/document");
const TemplateDocument = require("../models/templateDocument");
const { put } = require("@vercel/blob");

class OrganizationDefaultDocumentController {
  constructor(pool) {
    this.pool = pool;
    this.model = new OrganizationDefaultDocument(pool);
    this.documentModel = new Document(pool);
    this.templateModel = new TemplateDocument(pool);

    this.getAll = this.getAll.bind(this);
    this.getBySlot = this.getBySlot.bind(this);
    this.setWelcome = this.setWelcome.bind(this);
    this.setWelcomeUpload = this.setWelcomeUpload.bind(this);
    this.pushToAllOrganizations = this.pushToAllOrganizations.bind(this);
  }

  async initTable() {
    await this.model.initTable();
  }

  async getAll(req, res) {
    try {
      const rows = await this.model.getAll();
      return res.json({ success: true, defaults: rows });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch organization default documents",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }

  async getBySlot(req, res) {
    try {
      const { slot } = req.params;
      const row = await this.model.getBySlot(slot);
      if (!row)
        return res.status(404).json({
          success: false,
          message: `No default document for slot: ${slot}`,
        });
      return res.json({ success: true, default: row });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch organization default document",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }

  // Set the Welcome document template (template_document_id) - used when linking to onboarding template
  async setWelcome(req, res) {
    try {
      const { template_document_id } = req.body || {};
      if (!template_document_id) {
        return res.status(400).json({
          success: false,
          message: "template_document_id is required",
        });
      }

      const template = await this.templateModel.getById(template_document_id);
      if (!template) {
        return res.status(404).json({
          success: false,
          message: "Template document not found",
        });
      }

      const updated = await this.model.setSlot("welcome", template_document_id);
      return res.json({
        success: true,
        message: "Welcome document set",
        default: updated,
      });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to set Welcome document",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }

  // Upload Welcome document directly (Organization section only - no link to onboarding templates)
  async setWelcomeUpload(req, res) {
    try {
      const { file } = req.body || {};
      if (!file || !file.data) {
        return res.status(400).json({
          success: false,
          message: "File data is required",
        });
      }

      const base64Data = typeof file === "string" ? file : file.data;
      const mimeType = typeof file === "string" ? (req.body.mime_type || "application/pdf") : (file.type || "application/pdf");
      const originalName = typeof file === "string" ? (req.body.file_name || "welcome.pdf") : (file.name || "welcome.pdf");

      const buffer = Buffer.from(base64Data, "base64");
      const safeName = (originalName || "welcome.pdf").replace(/\s+/g, "_");
      const blob = await put(
        `organization-welcome/${Date.now()}_${safeName}`,
        buffer,
        { access: "public", contentType: mimeType }
      );

      await this.model.setSlotFile("welcome", {
        file_url: blob.url,
        file_name: originalName,
        mime_type: mimeType,
      });

      const updated = await this.model.getBySlot("welcome");
      return res.json({
        success: true,
        message: "Welcome document uploaded",
        default: updated,
      });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to upload Welcome document",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }

  // Push the current Welcome document to all organizations (supports both template link and direct file)
  async pushToAllOrganizations(req, res) {
    try {
      const slotRow = await this.model.getBySlot("welcome");
      if (!slotRow) {
        return res.status(400).json({
          success: false,
          message: "No Welcome document configured",
        });
      }

      let fileUrl, documentName, mimeType, fileSize;

      if (slotRow.file_url) {
        // Direct organization upload (no link to onboarding)
        fileUrl = slotRow.file_url;
        documentName = slotRow.document_name || slotRow.file_name || "Welcome Document";
        mimeType = slotRow.mime_type || "application/pdf";
        fileSize = null;
      } else if (slotRow.template_document_id) {
        const template = await this.templateModel.getById(slotRow.template_document_id);
        if (!template || !template.file_url) {
          return res.status(400).json({
            success: false,
            message: "Template document has no file",
          });
        }
        fileUrl = template.file_url;
        documentName = template.document_name || "Welcome Document";
        mimeType = template.mime_type || "application/pdf";
        fileSize = template.file_size || null;
      } else {
        return res.status(400).json({
          success: false,
          message: "No Welcome document file is configured",
        });
      }

      let orgDocs;
      if (slotRow.file_url) {
        orgDocs = await this.documentModel.getOrganizationWelcomeDocuments();
      } else {
        orgDocs = await this.documentModel.getBySourceTemplateId(slotRow.template_document_id);
      }

      let updated = 0;
      for (const doc of orgDocs) {
        await this.documentModel.update(doc.id, {
          file_path: fileUrl,
          file_size: fileSize,
          mime_type: mimeType,
          document_name: documentName,
        });
        updated++;
      }

      return res.json({
        success: true,
        message: `Pushed new version to ${updated} organization(s)`,
        updated,
      });
    } catch (e) {
      return res.status(500).json({
        success: false,
        message: "Failed to push to organizations",
        error: process.env.NODE_ENV === "production" ? undefined : e.message,
      });
    }
  }
}

module.exports = OrganizationDefaultDocumentController;
