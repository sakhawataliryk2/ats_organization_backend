// controllers/broadcastMessageController.js
const BroadcastMessage = require("../models/broadcastMessage");

class BroadcastMessageController {
  constructor(pool) {
    this.broadcastMessageModel = new BroadcastMessage(pool);
    this.getAll = this.getAll.bind(this);
    this.getById = this.getById.bind(this);
    this.create = this.create.bind(this);
    this.delete = this.delete.bind(this);
  }

  async initTables() {
    await this.broadcastMessageModel.initTable();
  }

  async getAll(req, res) {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const messages = await this.broadcastMessageModel.getAll(limit);
      return res.json({
        success: true,
        messages,
      });
    } catch (error) {
      console.error("Error fetching broadcast messages:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch broadcast messages",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getById(req, res) {
    try {
      const { id } = req.params;
      const message = await this.broadcastMessageModel.getById(id);
      if (!message) {
        return res.status(404).json({
          success: false,
          message: "Message not found",
        });
      }
      return res.json({
        success: true,
        message: message,
      });
    } catch (error) {
      console.error("Error fetching broadcast message:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch message",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async create(req, res) {
    try {
      const userId = req.user?.id;
      const { message } = req.body;

      if (!message || !message.trim()) {
        return res.status(400).json({
          success: false,
          message: "Message is required",
        });
      }

      const broadcastMessage = await this.broadcastMessageModel.create({
        message: message.trim(),
        created_by: userId,
      });

      return res.status(201).json({
        success: true,
        message: "Broadcast message posted successfully",
        broadcastMessage,
      });
    } catch (error) {
      console.error("Error creating broadcast message:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to post broadcast message",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async delete(req, res) {
    try {
      const { id } = req.params;
      const message = await this.broadcastMessageModel.delete(id);

      if (!message) {
        return res.status(404).json({
          success: false,
          message: "Message not found",
        });
      }

      return res.json({
        success: true,
        message: "Broadcast message deleted successfully",
        message: message,
      });
    } catch (error) {
      console.error("Error deleting broadcast message:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to delete broadcast message",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }
}

module.exports = BroadcastMessageController;

