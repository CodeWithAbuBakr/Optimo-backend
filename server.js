// server.js (fixed)
const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('@notionhq/client');
const multer = require("multer");
const cors = require('cors');
const dotenv = require('dotenv');
const FormData = require('form-data');
const axios = require('axios');

dotenv.config();
const upload = multer();
const app = express();

app.use(cors({
    credentials: true,
    origin: [
        'https://localhost:3000',
        'http://localhost:3000',
        'http://192.168.1.5:3000',
    ]
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); 

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || 'localhost';
const NOTION_VERSION = '2022-06-28'; 

// Validate env
if (!process.env.NOTION_API_KEY) {
    console.error("Missing NOTION_API_KEY in env — set it before starting server.");
    process.exit(1);
}
if (!process.env.NOTION_DASHBOARD_ID) {
    console.error("Missing NOTION_DASHBOARD_ID (target database ID) in env.");
    process.exit(1);
}
if (!process.env.NOTION_CASE_DB_ID) {
    console.error("Missing NOTION_CASE_DB_ID (cases DB ID) in env.");
    process.exit(1);
}

const notion = new Client({
    auth: process.env.NOTION_API_KEY,
});

const dashboardId = process.env.NOTION_DASHBOARD_ID;
const CASE_DB_ID = process.env.NOTION_CASE_DB_ID;

app.post("/add-task", upload.array("files"), async (req, res) => {
    try {
        const fileName = req.body.fileName || req.body.file_name || req.body.filename;
        const date = req.body.date || null;
        const link = req.body.link || null;
        const messageId = req.body.messageId || req.body.message_id || null;
        const linkedCase = req.body.linkedCase || req.body.linkedCaseId || req.body.linkedcase || null;
        const emailBody = req.body.emailBody || req.body.body || req.body.content || null;

        console.log("Received add-task:", {
            fileName,
            date,
            link,
            linkedCase,
            messageId,
            fileCount: Array.isArray(req.files) ? req.files.length : 0
        });

        if (!fileName) {
            return res.status(400).json({ success: false, message: "fileName (email subject) is required" });
        }

        const uploadedFiles = [];

        if (Array.isArray(req.files) && req.files.length) {
            for (const file of req.files) {
                const createUpload = await notion.request({
                    method: "POST",
                    path: "file_uploads",
                    body: {
                        mode: "single_part",
                        filename: file.originalname,
                        content_type: file.mimetype || "application/octet-stream"
                    }
                });

                const uploadId = createUpload.id;
                const uploadUrl = createUpload.upload_url;
                if (!uploadId || !uploadUrl) {
                    console.error("Bad upload slot response:", createUpload);
                    throw new Error("Failed to create Notion upload slot");
                }

                const form = new FormData();
                form.append('file', file.buffer, {
                    filename: file.originalname,
                    contentType: file.mimetype || "application/octet-stream"
                });

                const uploadResponse = await axios.post(uploadUrl, form, {
                    headers: {
                        Authorization: `Bearer ${process.env.NOTION_API_KEY}`,
                        "Notion-Version": NOTION_VERSION,
                        ...form.getHeaders()
                    },
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity
                });

                if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
                    console.error("Upload to Notion failed:", uploadResponse.status, uploadResponse.data);
                    throw new Error("File upload failed");
                }

                const uploadData = uploadResponse.data;
                uploadedFiles.push({
                    name: file.originalname,
                    type: "file_upload",
                    file_upload: { id: uploadId }
                });
            }
        }

        const properties = {
            "File Name": { title: [{ text: { content: fileName } }] },
            "File": { files: uploadedFiles },
            "File Type": { select: { name: "Email" } },
            "Message ID": { rich_text: messageId ? [{ text: { content: messageId } }] : [] }
        };

        if (date) properties["Date"] = { date: { start: date } };
        if (link) properties["Link"] = { url: link };
        if (linkedCase) {
            properties["Linked Case"] = {
                relation: [{ id: linkedCase }]
            };
        }

        // CREATE PAGE ONCE (keep same logic)
        const page = await notion.pages.create({
            parent: { database_id: dashboardId },
            properties
        });

        // Add email body as page content
        if (emailBody) {
            await notion.blocks.children.append({
                block_id: page.id,
                children: [
                    {
                        object: "block",
                        type: "paragraph",
                        paragraph: {
                            rich_text: [
                                { type: "text", text: { content: emailBody } }
                            ]
                        }
                    }
                ]
            });
        }

        // Use the same `page` (do not create again)
        console.log("Created Notion page:", page.id);
        res.status(200).json({ success: true, pageId: page.id });
    } catch (error) {
        console.error("Error creating Notion page:", error);
        if (error.body) console.error("Notion error body:", error.body);
        res.status(500).json({
            success: false,
            message: error.message || "Unknown error"
        });
    }
});

app.get('/search-cases', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q || q.length < 2) return res.json({ results: [] });

        const response = await fetch(`https://api.notion.com/v1/databases/${CASE_DB_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
                'Notion-Version': NOTION_VERSION,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filter: {
                    property: "File Name",
                    title: {
                        contains: q
                    }
                },
                page_size: 10
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error("Notion API error:", data);
            throw new Error(data.message || 'Notion API error');
        }

        const results = data.results.map(page => {
            const title = page.properties['File Name']?.title?.map(t => t.plain_text).join('') || "(untitled)";
            return {
                id: page.id,
                title,
                raw: page.properties
            };
        });

        res.json({ results });
    } catch (err) {
        console.error("Full error:", err);
        res.status(500).json({
            error: 'search failed',
            details: err.message
        });
    }
});


app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
});