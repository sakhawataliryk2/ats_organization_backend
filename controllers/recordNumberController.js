/**
 * Controller for resolving record id + module to business record_number.
 * GET /api/record-number/:module/:id returns { recordNumber }.
 */

const Job = require('../models/job');
const JobSeeker = require('../models/jobseeker');
const Organization = require('../models/organization');
const HiringManager = require('../models/hiringManager');
const Lead = require('../models/lead');
const Task = require('../models/task');
const Placement = require('../models/placement');

const MODULE_MODEL_MAP = {
    organization: Organization,
    organizations: Organization,
    job: Job,
    jobs: Job,
    'job-seeker': JobSeeker,
    'job-seekers': JobSeeker,
    jobseeker: JobSeeker,
    jobseekers: JobSeeker,
    'hiring-manager': HiringManager,
    'hiring-managers': HiringManager,
    hiringmanager: HiringManager,
    hiringmanagers: HiringManager,
    lead: Lead,
    leads: Lead,
    task: Task,
    tasks: Task,
    placement: Placement,
    placements: Placement,
};

class RecordNumberController {
    constructor(pool) {
        this.pool = pool;
        this.getRecordNumber = this.getRecordNumber.bind(this);
    }

    /**
     * GET /api/record-number/:module/:id
     * Returns { recordNumber: number | null }. 404 if module unknown or record not found.
     */
    async getRecordNumber(req, res) {
        try {
            const moduleSlug = (req.params.module || '').toLowerCase().trim();
            const id = parseInt(req.params.id, 10);

            if (!Number.isInteger(id) || id < 1) {
                return res.status(400).json({ success: false, message: 'id must be a positive integer' });
            }

            const ModelClass = MODULE_MODEL_MAP[moduleSlug];
            if (!ModelClass) {
                return res.status(400).json({
                    success: false,
                    message: `Unknown module: "${moduleSlug}". Supported: organization, job, job-seeker, hiring-manager, lead, task, placement`,
                });
            }

            const model = new ModelClass(this.pool);
            if (typeof model.initTable === 'function') {
                await model.initTable();
            }

            const record = await model.getById(id, null);
            if (!record) {
                return res.status(404).json({ success: false, message: 'Record not found', recordNumber: null });
            }

            const recordNumber = record.record_number != null ? record.record_number : null;
            return res.json({ success: true, recordNumber });
        } catch (err) {
            console.error('recordNumberController.getRecordNumber error:', err);
            return res.status(500).json({ success: false, message: 'Internal server error', recordNumber: null });
        }
    }
}

module.exports = RecordNumberController;
