// controllers/sharedDocumentController.js
const SharedDocument = require("../models/sharedDocument");

class SharedDocumentController {
  constructor(pool) {
    this.sharedDocumentModel = new SharedDocument(pool);
    this.getAll = this.getAll.bind(this);
    this.getById = this.getById.bind(this);
    this.create = this.create.bind(this);
    this.delete = this.delete.bind(this);
  }

  async initTables() {
    await this.sharedDocumentModel.initTable();
  }

  async getAll(req, res) {
    try {
      const documents = await this.sharedDocumentModel.getAll();
      return res.json({
        success: true,
        documents,
      });
    } catch (error) {
      console.error("Error fetching shared documents:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch shared documents",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getById(req, res) {
    try {
      const { id } = req.params;
      const document = await this.sharedDocumentModel.getById(id);
      if (!document) {
        return res.status(404).json({
          success: false,
          message: "Document not found",
        });
      }
      return res.json({
        success: true,
        document,
      });
    } catch (error) {
      console.error("Error fetching shared document:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch document",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async create(req, res) {
    try {
      const userId = req.user?.id;
      const { file_name, file_path, file_size, mime_type, description } = req.body;

      if (!file_name || !file_path) {
        return res.status(400).json({
          success: false,
          message: "File name and file path are required",
        });
      }

      const document = await this.sharedDocumentModel.create({
        file_name,
        file_path,
        file_size,
        mime_type,
        description,
        uploaded_by: userId,
      });

      return res.status(201).json({
        success: true,
        message: "Document uploaded successfully",
        document,
      });
    } catch (error) {
      console.error("Error creating shared document:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to upload document",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async delete(req, res) {
    try {
      const { id } = req.params;
      const document = await this.sharedDocumentModel.delete(id);

      if (!document) {
        return res.status(404).json({
          success: false,
          message: "Document not found",
        });
      }

      return res.json({
        success: true,
        message: "Document deleted successfully",
        document,
      });
    } catch (error) {
      console.error("Error deleting shared document:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to delete document",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }
}

module.exports = SharedDocumentController;

