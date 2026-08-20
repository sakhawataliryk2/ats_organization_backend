// controllers/jobXMLController.js
const { create } = require("xmlbuilder2");
const Job = require("../models/job");
const Organization = require("../models/organization");

function capitalize(str) {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

class JobXMLController {
    constructor(pool) {
        this.jobModel = new Job(pool);
        this.organizationModel = new Organization(pool);

        this.getXMLFeed = this.getXMLFeed.bind(this);
        this.initTables = this.initTables.bind(this);
    }

    // Initialize related tables so index.js startup init does not fail
    async initTables() {
        if (this.jobModel && typeof this.jobModel.initTable === "function") {
            await this.jobModel.initTable();
        }
        if (this.organizationModel && typeof this.organizationModel.initTable === "function") {
            await this.organizationModel.initTable();
        }
    }

    async getXMLFeed(req, res) {
        try {
            const jobs = await this.jobModel.getAll(null);

            const { status, type } = req.query || {};
            const requestedStatus = typeof status === "string" ? status.toLowerCase().trim() : "";
            const requestedType = typeof type === "string" ? type.toLowerCase().trim() : "";

            // Default behavior (no explicit status filter): only expose active/open jobs
            let filteredJobs = jobs;

            if (!requestedStatus) {
                filteredJobs = jobs.filter(job => {
                    const customStatus = job.custom_fields?.["Status"]?.toLowerCase();
                    const mainStatus = job.status?.toLowerCase();
                    return customStatus === "active" || mainStatus === "open";
                });
            } else if (requestedStatus !== "all") {
                filteredJobs = jobs.filter(job => {
                    const customStatus = job.custom_fields?.["Status"]?.toLowerCase();
                    const mainStatus = job.status?.toLowerCase();
                    const target = requestedStatus;

                    if (target === "open") {
                        return (
                            customStatus === "active" ||
                            mainStatus === "open" ||
                            mainStatus === "active"
                        );
                    }

                    if (target === "closed" || target === "inactive") {
                        return (
                            mainStatus === "closed" ||
                            mainStatus === "closed - filled" ||
                            customStatus === "inactive"
                        );
                    }

                    // Fallback: direct match
                    return customStatus === target || mainStatus === target;
                });
            }

            if (requestedType && requestedType !== "all") {
                filteredJobs = filteredJobs.filter(job => {
                    const jobType = (
                        job.job_type ||
                        job.custom_fields?.["Job Type"] ||
                        ""
                    )
                        .toString()
                        .toLowerCase()
                        .trim();
                    return jobType === requestedType;
                });
            }

            const frontendBase =
                process.env.FRONTEND_URL ||
                process.env.NEXT_PUBLIC_BASE_URL ||
                "https://yourcrm.com";
            const normalizedBase = frontendBase.replace(/\/$/, "");

            const feedObj = {
                source: {
                    publisher: "ABC Corp",
                    lastBuildDate: new Date().toISOString(),
                    jobs: await Promise.all(
                        filteredJobs.map(async (job) => {
                            let companyName = "ABC Corp";

                            if (job.organization_id) {
                                try {
                                    const org = await this.organizationModel.getById(job.organization_id);
                                    companyName = org?.name || companyName;
                                } catch (err) {
                                    console.error(`Error fetching org for job ${job.id}:`, err);
                                }
                            }

                            return {
                                job: {
                                    id: job.id,
                                    title: job.custom_fields?.["Published Job Title"] || job.job_title || "",
                                    description: job.custom_fields?.["Job Description Going to Job Board"] || job.job_description || "",
                                    location: [
                                        job.custom_fields?.["Address"],
                                        job.custom_fields?.["City"],
                                        job.custom_fields?.["State"],
                                        job.custom_fields?.["Zip"]
                                    ].filter(Boolean).join(', ') || job.address || "",
                                    date_posted: job.created_at
                                        ? new Date(job.created_at).toISOString().split("T")[0]
                                        : "",
                                    url: `${normalizedBase}/jobs/${job.id}`,
                                    company: companyName,
                                    job_type: capitalize(job.job_type),
                                    salary: job.custom_fields?.["Salary"] || job.salary || "",
                                }
                            };
                        })
                    )
                }
            };

            const xml = create(feedObj).end({ prettyPrint: true });

            res.setHeader("Content-Type", "application/xml");
            return res.status(200).send(xml);

        } catch (err) {
            console.error("Error generating XML feed:", err);
            return res.status(500).send("Failed to generate XML feed");
        }
    }
}

module.exports = JobXMLController;
