// controllers/jobseekerPortalTimecardsController.js
// Timecards for job seeker portal: list, create, update, submit (portal auth only)

const Timecard = require("../models/timecard");
const Placement = require("../models/placement");
const Onboarding = require("../models/onboarding");

function getJobSeekerId(req) {
  return req.portalUser?.job_seeker_id ?? null;
}

module.exports = function jobseekerPortalTimecardsController(pool) {
  const timecardModel = new Timecard(pool);
  const placementModel = new Placement(pool);
  const onboardingModel = new Onboarding(pool);

  return {
    async list(req, res) {
      try {
        const jobSeekerId = getJobSeekerId(req);
        if (!jobSeekerId) {
          return res.status(401).json({ success: false, message: "Unauthorized" });
        }
        const { from_week: fromWeek, to_week: toWeek, placement_id: placementId, status } = req.query;
        const timecards = await timecardModel.listByJobSeekerId(Number(jobSeekerId), {
          fromWeek: fromWeek || undefined,
          toWeek: toWeek || undefined,
          placementId: placementId ? Number(placementId) : undefined,
          status: status || undefined,
        });
        return res.json({ success: true, timecards });
      } catch (e) {
        console.error("[jobseekerPortalTimecards] list", e);
        return res.status(500).json({ success: false, message: "Server error" });
      }
    },

    async getById(req, res) {
      try {
        const jobSeekerId = getJobSeekerId(req);
        if (!jobSeekerId) {
          return res.status(401).json({ success: false, message: "Unauthorized" });
        }
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "Invalid timecard id" });
        const timecard = await timecardModel.getById(id, jobSeekerId);
        if (!timecard) {
          return res.status(404).json({ success: false, message: "Timecard not found" });
        }
        return res.json({ success: true, timecard });
      } catch (e) {
        console.error("[jobseekerPortalTimecards] getById", e);
        return res.status(500).json({ success: false, message: "Server error" });
      }
    },

    async placements(req, res) {
      try {
        const jobSeekerId = getJobSeekerId(req);
        if (!jobSeekerId) {
          return res.status(401).json({ success: false, message: "Unauthorized" });
        }
        const canAccess = await onboardingModel.canAccessTimecard(jobSeekerId);
        if (!canAccess) {
          return res.json({ success: true, timecard_enabled: false, placements: [] });
        }
        const all = await placementModel.findByJobSeekerId(jobSeekerId);
        const approved = (all || []).filter(
          (p) => (p.status || "").toLowerCase() === "approved"
        );
        return res.json({
          success: true,
          timecard_enabled: true,
          placements: approved.map((p) => ({
            id: p.id,
            record_number: p.record_number,
            job_title: p.jobTitle,
            organization_name: p.organizationName,
            start_date: p.startDate,
          })),
        });
      } catch (e) {
        console.error("[jobseekerPortalTimecards] placements", e);
        return res.status(500).json({ success: false, message: "Server error" });
      }
    },

    async access(req, res) {
      try {
        const jobSeekerId = getJobSeekerId(req);
        if (!jobSeekerId) {
          return res.status(401).json({ success: false, message: "Unauthorized" });
        }
        const ok = await onboardingModel.canAccessTimecard(jobSeekerId);
        return res.json({ success: true, timecard_enabled: !!ok });
      } catch (e) {
        console.error("[jobseekerPortalTimecards] access", e);
        return res.status(500).json({ success: false, message: "Server error" });
      }
    },

    async create(req, res) {
      try {
        const jobSeekerId = getJobSeekerId(req);
        if (!jobSeekerId) {
          return res.status(401).json({ success: false, message: "Unauthorized" });
        }
        const placementId = Number(req.body.placement_id);
        if (!placementId) {
          return res.status(400).json({ success: false, message: "placement_id is required" });
        }
        const result = await timecardModel.create(jobSeekerId, placementId, req.body);
        if (result.error) {
          return res.status(400).json({ success: false, message: result.error });
        }
        const timecard = timecardModel._format(result.row);
        return res.status(201).json({ success: true, timecard });
      } catch (e) {
        console.error("[jobseekerPortalTimecards] create", e);
        return res.status(500).json({ success: false, message: "Server error" });
      }
    },

    async update(req, res) {
      try {
        const jobSeekerId = getJobSeekerId(req);
        if (!jobSeekerId) {
          return res.status(401).json({ success: false, message: "Unauthorized" });
        }
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "Invalid timecard id" });
        const result = await timecardModel.update(id, jobSeekerId, req.body);
        if (result.error) {
          return res.status(400).json({ success: false, message: result.error });
        }
        const timecard = timecardModel._format(result.row);
        return res.json({ success: true, timecard });
      } catch (e) {
        console.error("[jobseekerPortalTimecards] update", e);
        return res.status(500).json({ success: false, message: "Server error" });
      }
    },

    async submit(req, res) {
      try {
        const jobSeekerId = getJobSeekerId(req);
        if (!jobSeekerId) {
          return res.status(401).json({ success: false, message: "Unauthorized" });
        }
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ success: false, message: "Invalid timecard id" });
        const result = await timecardModel.submit(id, jobSeekerId);
        if (result.error) {
          return res.status(400).json({ success: false, message: result.error });
        }
        const timecard = timecardModel._format(result.row);
        return res.json({ success: true, timecard });
      } catch (e) {
        console.error("[jobseekerPortalTimecards] submit", e);
        return res.status(500).json({ success: false, message: "Server error" });
      }
    },
  };
};
