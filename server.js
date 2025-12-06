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
const PORT = 5000;
const HOST = 'localhost';
const NOTION_VERSION = '2022-06-28'; 
const notion = new Client({
    auth: process.env.NOTION_API_KEY,
    notionVersion: NOTION_VERSION 
});
const dashboardId = process.env.NOTION_DASHBOARD_ID;

/**
 * Expected form-data fields:
 * - files: file attachments (zero or more)
 * - fileName: email subject (string)
 * - date: ISO date string (email sent date) -> optional
 * - link: URL string (Outlook "open in browser") -> optional
 * - linkedCase: Notion page id (string) -> optional (if provided will add a relation)
 * - messageId: unique Outlook message-id (string) -> optional
 */
app.post("/add-task", upload.array("files"), async (req, res) => {
    try {
        const { fileName, date, link, linkedCase, messageId } = req.body;
        if (!fileName) {
            return res.status(400).json({ success: false, message: "fileName (email subject) is required" });
        }
        const uploadedFiles = [];
        // ====== 1) Upload each file to Notion ======
        if (Array.isArray(req.files) && req.files.length) {
            for (const file of req.files) {
                // Step 1: Create upload slot
                const createUpload = await notion.request({
                    method: "POST",
                    path: "file_uploads",
                    body: {
                        mode: "single_part", // Explicit for small files
                        filename: file.originalname,
                        content_type: file.mimetype || "application/octet-stream"
                    }
                });
                const uploadId = createUpload.id;
                const uploadUrl = createUpload.upload_url || `https://api.notion.com/v1/file_uploads/${uploadId}/send`;

                // Step 2: Prepare form data
                const form = new FormData();
                form.append('file', file.buffer, {
                    filename: file.originalname,
                    contentType: file.mimetype || "application/octet-stream"
                });

                // Step 3: Send the file using axios for reliable multipart handling
                const uploadResponse = await axios.post(uploadUrl, form, {
                    headers: {
                        "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
                        "Notion-Version": NOTION_VERSION,
                        ...form.getHeaders()
                    }
                });

                if (uploadResponse.status !== 200) {
                    const errorDetails = uploadResponse.data || 'No details available';
                    console.error("Notion upload error details:", errorDetails);
                    throw new Error(`File upload failed: ${uploadResponse.status} - ${JSON.stringify(errorDetails)}`);
                }

                const uploadData = uploadResponse.data;
                if (uploadData.status !== "uploaded") {
                    throw new Error(`File upload failed: ${uploadData.status}`);
                }

                uploadedFiles.push({
                    name: file.originalname,
                    type: "file_upload",
                    file_upload: { id: uploadId }
                });
            }
        }
        // ====== 2) Build Notion properties ======
        const properties = {
            "File Name": {
                title: [{ text: { content: fileName } }]
            },
            "File": {
                files: uploadedFiles
            },
            "File Type": {
                select: { name: "Email" } // <-- Fixed
            },
            "Message ID": {
                rich_text: messageId ? [{ text: { content: messageId } }] : []
            }
        };
        if (date) properties["Date"] = { date: { start: date } };
        if (link) properties["Link"] = { url: link };
        if (linkedCase) {
            properties["Linked Case"] = {
                relation: [{ id: linkedCase }]
            };
        }
        // ====== 3) Create page ======
        const response = await notion.pages.create({
            parent: { database_id: dashboardId },
            properties
        });
        res.status(200).json({ success: true, pageId: response.id });
    } catch (error) {
        console.error("Error creating Notion page:", error);
        if (error.body) console.error("Notion error body:", error.body);
        res.status(500).json({
            success: false,
            message: error.message || "Unknown error"
        });
    }
});
app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);
});