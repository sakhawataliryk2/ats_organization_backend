const Office = require('../models/office');

class OfficeController {
    constructor(pool) {
        this.officeModel = new Office(pool);
        this.getAllOffices = this.getAllOffices.bind(this);
        this.createOffice = this.createOffice.bind(this);
        this.updateOffice = this.updateOffice.bind(this);
        this.deleteOffice = this.deleteOffice.bind(this);
    }

    // Initialize database tables
    async initTables() {
        await this.officeModel.initTable();
    }

    async getAllOffices(req, res) {
        try {
            const offices = await this.officeModel.getAll();
            res.status(200).json({
                success: true,
                offices
            });
        } catch (error) {
            console.error('Error fetching offices:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch offices',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async createOffice(req, res) {
        try {
            const officeData = req.body;
            const office = await this.officeModel.create(officeData);
            res.status(201).json({
                success: true,
                office
            });
        } catch (error) {
            console.error('Error creating office:', error);
            const isValidation = error.message && error.message.includes('building_type');
            res.status(isValidation ? 400 : 500).json({
                success: false,
                message: isValidation ? error.message : 'Failed to create office',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async updateOffice(req, res) {
        try {
            const { id } = req.params;
            const officeData = req.body;
            const office = await this.officeModel.update(id, officeData);
            res.status(200).json({
                success: true,
                office
            });
        } catch (error) {
            console.error('Error updating office:', error);
            const isValidation = error.message && error.message.includes('building_type');
            res.status(isValidation ? 400 : 500).json({
                success: false,
                message: isValidation ? error.message : 'Failed to update office',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async deleteOffice(req, res) {
        try {
            const { id } = req.params;
            await this.officeModel.delete(id);
            res.status(200).json({
                success: true,
                message: 'Office deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting office:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to delete office',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }
}

module.exports = OfficeController;