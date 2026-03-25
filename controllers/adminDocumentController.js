// controllers/adminDocumentController.js
const AdminDocument = require("../models/adminDocument");

class AdminDocumentController {
  constructor(pool) {
    this.adminDocumentModel = new AdminDocument(pool);
    this.getAll = this.getAll.bind(this);
    this.getById = this.getById.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.delete = this.delete.bind(this);
    this.getCategories = this.getCategories.bind(this);
  }

  async initTables() {
    await this.adminDocumentModel.initTable();
  }

  async getAll(req, res) {
    try {
      const { search = "", category = "", page = 1, limit = 250, sortBy = "document_name", sortOrder = "ASC" } = req.query;
      const filters = {
        search,
        category,
        page: parseInt(page),
        limit: parseInt(limit),
        sortBy,
        sortOrder,
      };
      const result = await this.adminDocumentModel.getAll(filters);
      return res.json({
        success: true,
        ...result,
      });
    } catch (error) {
      console.error("Error fetching admin documents:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch documents",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getById(req, res) {
    try {
      const { id } = req.params;
      const document = await this.adminDocumentModel.getById(id);
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
      console.error("Error fetching admin document:", error);
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
      const { document_name, category, content, file_path, file_size, mime_type } = req.body;

      if (!document_name || !document_name.trim()) {
        return res.status(400).json({
          success: false,
          message: "Document name is required",
        });
      }

      if (!category || !category.trim()) {
        return res.status(400).json({
          success: false,
          message: "Category is required",
        });
      }

      const document = await this.adminDocumentModel.create({
        document_name: document_name.trim(),
        category: category.trim(),
        content,
        file_path,
        file_size,
        mime_type,
        created_by: userId,
      });

      return res.status(201).json({
        success: true,
        message: "Document created successfully",
        document,
      });
    } catch (error) {
      console.error("Error creating admin document:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to create document",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async update(req, res) {
    try {
      const { id } = req.params;
      const { document_name, category, content, file_path, file_size, mime_type } = req.body;

      const document = await this.adminDocumentModel.update(id, {
        document_name,
        category,
        content,
        file_path,
        file_size,
        mime_type,
      });

      if (!document) {
        return res.status(404).json({
          success: false,
          message: "Document not found",
        });
      }

      return res.json({
        success: true,
        message: "Document updated successfully",
        document,
      });
    } catch (error) {
      console.error("Error updating admin document:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to update document",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async delete(req, res) {
    try {
      const { id } = req.params;
      const document = await this.adminDocumentModel.delete(id);

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
      console.error("Error deleting admin document:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to delete document",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getCategories(req, res) {
    try {
      const categories = await this.adminDocumentModel.getCategories();
      return res.json({
        success: true,
        categories,
      });
    } catch (error) {
      console.error("Error fetching categories:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch categories",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }
}

module.exports = AdminDocumentController;

