const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const ScrapeController = require('../controllers/scrapeController');

function createScrapeRouter(pool) {
    const scrapeController = new ScrapeController(pool);

    // Scrape Toponehire.com
    router.post('/toponehire', verifyToken, scrapeController.scrapeToponehire.bind(scrapeController));

    return router;
}

module.exports = createScrapeRouter;

