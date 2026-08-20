// routes/jobXMLRoutes.js
const express = require("express");

function createJobXMLRouter(jobXMLController) {
    const router = express.Router();

    router.get("/", jobXMLController.getXMLFeed);

    return router;
}

module.exports = createJobXMLRouter;