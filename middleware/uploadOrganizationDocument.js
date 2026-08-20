const multer = require("multer");

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "image/jpeg",
    "image/png",
    "image/gif",
  ];
  
  const isValidType =
    allowedTypes.includes(file.mimetype) ||
    file.originalname.match(/\.(pdf|doc|docx|txt|jpg|jpeg|png|gif)$/i);

  if (!isValidType) {
    return cb(
      new Error(
        "Invalid file type. Allowed: PDF, DOC, DOCX, TXT, JPG, PNG, GIF"
      )
    );
  }
  cb(null, true);
};

const uploadOrganizationDocument = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

module.exports = uploadOrganizationDocument;
