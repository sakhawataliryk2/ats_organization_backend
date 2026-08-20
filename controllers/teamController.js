const Team = require('../models/team');

class TeamController {
    constructor(pool) {
        this.teamModel = new Team(pool);
        this.getAllTeams = this.getAllTeams.bind(this);
        this.createTeam = this.createTeam.bind(this);
        this.getTeamMembers = this.getTeamMembers.bind(this);
        this.addTeamMember = this.addTeamMember.bind(this);
        this.removeTeamMember = this.removeTeamMember.bind(this);
        this.updateTeam = this.updateTeam.bind(this);
        this.deleteTeam = this.deleteTeam.bind(this);
    }

    // Initialize database tables
    async initTables() {
        await this.teamModel.initTable();
    }

    async getAllTeams(req, res) {
        try {
            const teams = await this.teamModel.getAll();
            res.status(200).json({
                success: true,
                teams
            });
        } catch (error) {
            console.error('Error fetching teams:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch teams',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async createTeam(req, res) {
        try {
            const teamData = req.body;
            const team = await this.teamModel.create(teamData);
            res.status(201).json({
                success: true,
                team
            });
        } catch (error) {
            console.error('Error creating team:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to create team',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async getTeamMembers(req, res) {
        try {
            const { id } = req.params;
            const members = await this.teamModel.getMembers(id);
            res.status(200).json({
                success: true,
                members
            });
        } catch (error) {
            console.error('Error fetching team members:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch team members',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async addTeamMember(req, res) {
        try {
            const { id } = req.params;
            const memberData = req.body;
            const member = await this.teamModel.addMember(id, memberData);
            res.status(201).json({
                success: true,
                member
            });
        } catch (error) {
            console.error('Error adding team member:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to add team member',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async removeTeamMember(req, res) {
        try {
            const { id, userId } = req.params;
            await this.teamModel.removeMember(id, userId);
            res.status(200).json({
                success: true,
                message: 'Team member removed successfully'
            });
        } catch (error) {
            console.error('Error removing team member:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to remove team member',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async updateTeam(req, res) {
        try {
            const { id } = req.params;
            const teamData = req.body;
            const team = await this.teamModel.update(id, teamData);
            res.status(200).json({
                success: true,
                team
            });
        } catch (error) {
            console.error('Error updating team:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to update team',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }

    async deleteTeam(req, res) {
        try {
            const { id } = req.params;
            await this.teamModel.delete(id);
            res.status(200).json({
                success: true,
                message: 'Team deleted successfully'
            });
        } catch (error) {
            console.error('Error deleting team:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to delete team',
                error: process.env.NODE_ENV === 'production' ? undefined : error.message
            });
        }
    }
}

module.exports = TeamController;