const Packet = require("../models/Packet");

class PacketController {
  constructor(pool) {
    this.packetModel = new Packet(pool);

    this.list = this.list.bind(this);
    this.getOne = this.getOne.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.remove = this.remove.bind(this);
  }

  async list(req, res) {
    try {
      const search = (req.query.search || "").toString();
      const packets = await this.packetModel.list({ search });
      return res.json({ success: true, packets });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  async getOne(req, res) {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res
          .status(422)
          .json({ success: false, message: "Invalid packet id" });
      }

      const packet = await this.packetModel.getById(id);
      if (!packet) {
        return res
          .status(404)
          .json({ success: false, message: "Packet not found" });
      }
      return res.json({ success: true, packet });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  async create(req, res) {
    try {
      const { packet_name } = req.body;

      if (!packet_name || !packet_name.trim()) {
        return res.status(422).json({
          success: false,
          message: "Validation failed",
          errors: { packet_name: ["Packet name is required"] },
        });
      }

      // Accept BOTH formats:
      // 1) documents: [{document_id, sort_order}]  <-- your frontend
      // 2) document_ids: [1,2,3]
      const documentsFromUI = Array.isArray(req.body.documents)
        ? req.body.documents
        : null;
      const documentIds = Array.isArray(req.body.document_ids)
        ? req.body.document_ids
        : null;

      let documentsPayload = [];

      if (documentsFromUI) {
        documentsPayload = documentsFromUI; // Packet model will normalize (document_id -> template_document_id)
      } else if (documentIds) {
        documentsPayload = documentIds
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n) && n > 0);
      }

      const created_by = req.user?.id || null; // if auth middleware provides req.user

      const packet = await this.packetModel.create({
        packet_name: packet_name.trim(),
        created_by,
        documents: documentsPayload,
      });

      return res.json({ success: true, packet });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

 async update(req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res
        .status(422)
        .json({ success: false, message: "Invalid packet id" });
    }

    const packet_name =
      typeof req.body.packet_name === "string" ? req.body.packet_name.trim() : null;

    // IMPORTANT:
    // - if "documents" field is NOT present => do not touch mappings
    // - if "documents" is present (even empty array) => replace mappings
    let documentsPayload = null;

    if (Object.prototype.hasOwnProperty.call(req.body, "documents")) {
      const docs = Array.isArray(req.body.documents) ? req.body.documents : [];

      documentsPayload = docs
        .map((d) => ({
          template_document_id: Number(d.document_id), // map UI key -> DB key
          sort_order: Number(d.sort_order),
        }))
        .filter(
          (d) =>
            Number.isFinite(d.template_document_id) &&
            d.template_document_id > 0 &&
            Number.isFinite(d.sort_order)
        );
    }

    const updated = await this.packetModel.update(id, {
      packet_name,
      documents: documentsPayload, // null => don't touch, [] => wipe intentionally
    });

    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Packet not found" });
    }

    return res.json({ success: true, packet: updated });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
}


  async remove(req, res) {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res
          .status(422)
          .json({ success: false, message: "Invalid packet id" });
      }

      const removed = await this.packetModel.softDelete(id);
      if (!removed) {
        return res
          .status(404)
          .json({ success: false, message: "Packet not found" });
      }
      return res.json({ success: true, packet: removed });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }
}

module.exports = PacketController;
