// controllers/tearsheetController.js
const Tearsheet = require("../models/tearsheet");

class TearsheetController {
  constructor(pool) {
    this.tearsheetModel = new Tearsheet(pool);
    this.create = this.create.bind(this);
    this.getAll = this.getAll.bind(this);
    this.getById = this.getById.bind(this);
    this.getRecords = this.getRecords.bind(this);
    this.getOrganizations = this.getOrganizations.bind(this);
    this.getTearsheetsByOrganizationId = this.getTearsheetsByOrganizationId.bind(this);
    this.getPlacements = this.getPlacements.bind(this);
    this.delete = this.delete.bind(this);
    this.associate = this.associate.bind(this);
  }

  async initTables() {
    await this.tearsheetModel.initTable();
  }

  async getAll(req, res) {
    try {
      const tearsheets = await this.tearsheetModel.getAll();
      console.log('Tearsheets:', tearsheets);
      return res.json({ success: true, tearsheets });
    } catch (error) {
      console.error("Error fetching tearsheets:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch tearsheets",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getById(req, res) {
    try {
      const { id } = req.params;
      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          success: false,
          message: "Invalid tearsheet ID",
        });
      }
      const tearsheet = await this.tearsheetModel.getById(parseInt(id));
      if (!tearsheet) {
        return res.status(404).json({
          success: false,
          message: "Tearsheet not found",
        });
      }
      return res.json({ success: true, tearsheet });
    } catch (error) {
      console.error("Error fetching tearsheet:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch tearsheet",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async create(req, res) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      const {
        name,
        visibility = "Existing",
        job_id,
        job_seeker_id,
        hiring_manager_id,
        lead_id,
      } = req.body || {};

      if (!name || (typeof name === "string" && !name.trim())) {
        return res.status(400).json({
          success: false,
          message: "Tearsheet name is required",
        });
      }

      const tearsheet = await this.tearsheetModel.create({
        name: String(name).trim(),
        visibility,
        job_id: job_id ?? null,
        job_seeker_id: job_seeker_id ?? null,
        hiring_manager_id: hiring_manager_id ?? null,
        lead_id: lead_id ?? null,
        created_by: userId,
      });

      return res.status(201).json({
        success: true,
        message: "Tearsheet created successfully",
        tearsheet,
      });
    } catch (error) {
      console.error("Error creating tearsheet:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to create tearsheet",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getRecords(req, res) {
    try {
      const { id } = req.params;
      const { type } = req.query;

      if (!id || !type) {
        return res.status(400).json({
          success: false,
          message: "Tearsheet ID and type are required",
        });
      }

      const validTypes = ['job_seekers', 'hiring_managers', 'jobs', 'leads', 'tasks', 'placements'];
      if (!validTypes.includes(type)) {
        return res.status(400).json({
          success: false,
          message: "Invalid type. Must be one of: job_seekers, hiring_managers, jobs, leads, tasks, placements",
        });
      }

      const records = await this.tearsheetModel.getRecordsByType(parseInt(id), type);

      return res.json({
        success: true,
        records,
        count: records.length
      });
    } catch (error) {
      console.error("Error fetching tearsheet records:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch tearsheet records",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getOrganizations(req, res) {
    try {
      const { id } = req.params;
      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          success: false,
          message: "Invalid tearsheet ID",
        });
      }
      const organizations = await this.tearsheetModel.getOrganizations(parseInt(id));
      return res.json({
        success: true,
        organizations,
        count: organizations.length,
      });
    } catch (error) {
      console.error("Error fetching tearsheet organizations:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch organizations",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getTearsheetsByOrganizationId(req, res) {
    try {
      const { organizationId } = req.params;
      if (!organizationId || isNaN(parseInt(organizationId))) {
        return res.status(400).json({
          success: false,
          message: "Invalid organization ID",
        });
      }
      const tearsheets = await this.tearsheetModel.getTearsheetsByOrganizationId(parseInt(organizationId));
      return res.json({
        success: true,
        tearsheets,
      });
    } catch (error) {
      console.error("Error fetching tearsheets for organization:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch tearsheets for organization",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getTearsheetsByJobId(req, res) {
    try {
      const { jobId } = req.params;
      if (!jobId || isNaN(parseInt(jobId))) {
        return res.status(400).json({
          success: false,
          message: "Invalid job ID",
        });
      }
      const tearsheets = await this.tearsheetModel.getTearsheetsByJobId(parseInt(jobId));
      return res.json({ success: true, tearsheets });
    } catch (error) {
      console.error("Error fetching tearsheets for job:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch tearsheets for job",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getTearsheetsByLeadId(req, res) {
    try {
      const { leadId } = req.params;
      if (!leadId || isNaN(parseInt(leadId))) {
        return res.status(400).json({
          success: false,
          message: "Invalid lead ID",
        });
      }
      const tearsheets = await this.tearsheetModel.getTearsheetsByLeadId(parseInt(leadId));
      return res.json({ success: true, tearsheets });
    } catch (error) {
      console.error("Error fetching tearsheets for lead:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch tearsheets for lead",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getTearsheetsByHiringManagerId(req, res) {
    try {
      const { hiringManagerId } = req.params;
      if (!hiringManagerId || isNaN(parseInt(hiringManagerId))) {
        return res.status(400).json({
          success: false,
          message: "Invalid hiring manager ID",
        });
      }
      const tearsheets = await this.tearsheetModel.getTearsheetsByHiringManagerId(parseInt(hiringManagerId));
      return res.json({ success: true, tearsheets });
    } catch (error) {
      console.error("Error fetching tearsheets for hiring manager:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch tearsheets for hiring manager",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getTearsheetsByJobSeekerId(req, res) {
    try {
      const { jobSeekerId } = req.params;
      if (!jobSeekerId || isNaN(parseInt(jobSeekerId))) {
        return res.status(400).json({
          success: false,
          message: "Invalid job seeker ID",
        });
      }
      const tearsheets = await this.tearsheetModel.getTearsheetsByJobSeekerId(parseInt(jobSeekerId));
      return res.json({ success: true, tearsheets });
    } catch (error) {
      console.error("Error fetching tearsheets for job seeker:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch tearsheets for job seeker",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getTearsheetsByTaskId(req, res) {
    try {
      const { taskId } = req.params;
      if (!taskId || isNaN(parseInt(taskId))) {
        return res.status(400).json({
          success: false,
          message: "Invalid task ID",
        });
      }
      const tearsheets = await this.tearsheetModel.getTearsheetsByTaskId(parseInt(taskId));
      return res.json({ success: true, tearsheets });
    } catch (error) {
      console.error("Error fetching tearsheets for task:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch tearsheets for task",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async getPlacements(req, res) {
    try {
      const { id } = req.params;
      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          success: false,
          message: "Invalid tearsheet ID",
        });
      }
      const placements = await this.tearsheetModel.getPlacements(parseInt(id));
      return res.json({
        success: true,
        placements,
        count: placements.length,
      });
    } catch (error) {
      console.error("Error fetching tearsheet placements:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to fetch placements",
        error: process.env.NODE_ENV === "production" ? undefined : error.message,
      });
    }
  }

  async delete(req, res) {
    try {
      const { id } = req.params;

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          success: false,
          message: 'Invalid tearsheet ID',
        });
      }

      const tearsheet = await this.tearsheetModel.delete(parseInt(id));

      if (!tearsheet) {
        return res.status(404).json({
          success: false,
          message: 'Tearsheet not found',
        });
      }

      return res.json({
        success: true,
        message: 'Tearsheet deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting tearsheet:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to delete tearsheet',
        error: process.env.NODE_ENV === 'production' ? undefined : error.message,
      });
    }
  }

  async associate(req, res) {
    try {
      const { id } = req.params;
      const { job_seeker_id, hiring_manager_id, job_id, lead_id, organization_id, task_id, placement_id } = req.body;

      console.log('Associating record with tearsheet:', { id, job_seeker_id, hiring_manager_id, job_id, lead_id, organization_id });

      if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
          success: false,
          message: 'Invalid tearsheet ID',
        });
      }

      await this.tearsheetModel.associate(parseInt(id), {
        job_seeker_id: job_seeker_id ? parseInt(job_seeker_id) : null,
        hiring_manager_id: hiring_manager_id ? parseInt(hiring_manager_id) : null,
        job_id: job_id ? parseInt(job_id) : null,
        lead_id: lead_id ? parseInt(lead_id) : null,
        organization_id: organization_id ? parseInt(organization_id) : null,
        task_id: task_id ? parseInt(task_id) : null,
        placement_id: placement_id ? parseInt(placement_id) : null,
      });

      return res.json({
        success: true,
        message: 'Record associated with tearsheet successfully',
      });
    } catch (error) {
      console.error('Error associating record with tearsheet:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to associate record with tearsheet',
        error: error.message,
      });
    }
  }
}

module.exports = TearsheetController;


