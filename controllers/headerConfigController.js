// controllers/headerConfigController.js
const HeaderConfig = require("../models/headerConfig");

class HeaderConfigController {
  constructor(pool) {
    this.headerConfigModel = new HeaderConfig(pool);

    this.get = this.get.bind(this);
    this.upsert = this.upsert.bind(this);
  }

  async initTables() {
    try {
      await this.headerConfigModel.initTable();
      console.log("✅ Header config tables initialized successfully");
    } catch (error) {
      console.error("❌ Error initializing header config tables:", error);
      throw error;
    }
  }

  // helper: parse jsonb safely
  parseJsonb(value) {
    try {
      return typeof value === "string" ? JSON.parse(value) : value || [];
    } catch (e) {
      return [];
    }
  }

  // GET /api/header-config?entityType=ORGANIZATION&configType=columns
  async get(req, res) {
    try {
      const { entityType } = req.query;
      const configType = req.query.configType || "header"; // "header" | "columns"

      if (!entityType) {
        return res.status(400).json({
          success: false,
          message: "Entity type is required",
        });
      }

      // ✅ MUST pass configType so model selects correct column as "fields"
      const config = await this.headerConfigModel.getByEntityType(
        entityType,
        configType
      );

     if (!config) {
       return res.status(200).json({
         success: true,
         entityType,
         configType,
         [configType === "header" ? "headerFields" : "listColumns"]: [],
       });
     }


      const parsedFields = this.parseJsonb(config.fields);

      return res.status(200).json({
        success: true,
        entityType: config.entity_type,
        configType,
        [configType === "header" ? "headerFields" : "listColumns"]:
          parsedFields, // ✅ key fixed
        createdAt: config.created_at,
        updatedAt: config.updated_at,
      });
    } catch (error) {
      console.error("Error fetching header config:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch configuration",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
  }

  // controllers/headerConfigController.js

  async upsert(req, res) {
    console.log("🧪 Full query object:", req.query);

    console.log("🔍 Incoming configType:", req.query.configType);

    try {
      const { entityType, configType } = req.query;

      if (!entityType) {
        return res.status(400).json({
          success: false,
          message: "Entity type is required",
        });
      }

      if (!configType || !["header", "columns"].includes(configType)) {
        console.log("❌ BLOCKED REQUEST →", req.originalUrl);
        console.log("🧨 Missing or invalid configType:", configType);
        return res.status(400).json({
          success: false,
          message: "configType is required (header | columns)",
        });
      }

      const { headerFields, fields } = req.body; // support both payload names
      const fieldsToSave = headerFields ?? fields ?? [];

      if (!Array.isArray(fieldsToSave)) {
        return res.status(400).json({
          success: false,
          message: "fields must be an array",
        });
      }

      const userId = req.user?.id || null;

      // ✅ IMPORTANT: pass configType so model writes correct DB column
      await this.headerConfigModel.upsert(
        entityType,
        fieldsToSave,
        userId,
        configType
      );

      // ✅ return what was saved
      const config = await this.headerConfigModel.getByEntityType(
        entityType,
        configType
      );
      const parsedFields = this.parseJsonb(config?.fields);

      return res.status(200).json({
        success: true,
        message: "Configuration saved successfully",
        entityType,
        configType,
        [configType === "header" ? "headerFields" : "listColumns"]:
          parsedFields,
        updatedAt: config?.updated_at,
      });

    } catch (error) {
      console.error("Error saving header config:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to save configuration",
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      });
    }
  }
}

module.exports = HeaderConfigController;
