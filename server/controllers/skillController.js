const Skill = require('../models/Skill');
const asyncHandler = require('../utils/asyncHandler');
const { getAuth } = require('@clerk/express');
const { clerkClient } = require('@clerk/clerk-sdk-node');
const path = require('path');
const fs = require('fs');
const util = require('util')
const cloudinary = require('../config/cloudinary');
const unlinkFile = util.promisify(fs.unlink);
const axios = require('axios');
const FormData = require('form-data');

//python ocr + verification
async function verifyWithPython(filePath) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(filePath));

  const response = await axios.post(
    'http://localhost:5005/verify',
    formData,
    {
      headers: formData.getHeaders(),
      timeout: 15000
    }
  );

  return response.data;
}

async function getUserEmail(userId) {
  if (!userId) return null;
  const user = await clerkClient.users.getUser(userId);
  const emails = user?.emailAddresses || [];
  if (emails.length === 0) return null;
  const primary = emails.find((e) => e.id === user.primaryEmailAddressId);
  return primary?.emailAddress || emails[0]?.emailAddress || null;
}

const generateFileUrl = (req, filePath) => {
  const fileName = path.basename(filePath);
  const uploadType = filePath.includes("certificates")
    ? "certificates"
    : filePath.includes("videos")
      ? "videos"
      : "uploads";
  return `/uploads/${uploadType}/${fileName}`;
};

const uploadToCloud = async (filePath, folder, resourceType = 'auto') => {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder: `skill_exchange/${folder}`,
      resource_type: resourceType,
    });
    // Delete local file after successful upload
    await unlinkFile(filePath);
    return result.secure_url;
  } catch (error) {
    // If upload fails, still try to delete local file
    await unlinkFile(filePath).catch(() => { });
    throw new Error(`Cloud upload failed: ${error.message}`);
  }
};

// GET published skills
exports.getSkills = asyncHandler(async (req, res) => {
  const { category, level, paymentOptions, page = 1, limit = 10, sort = 'recent' } = req.query;

  const filter = { status: 'published' };
  if (category && category !== 'all') filter.category = new RegExp(category, 'i');
  if (level && level !== 'all') filter.level = level;
  if (paymentOptions && paymentOptions !== 'all') filter.paymentOptions = paymentOptions;

  const l = parseInt(limit);
  const p = parseInt(page);

  let sortOptions = { createdAt: -1 };
  if (sort === 'rating') {
    sortOptions = { averageRating: -1, totalRatings: -1 };
  }

  const [items, total] = await Promise.all([
    Skill.find(filter).sort(sortOptions).limit(l).skip((p - 1) * l),
    Skill.countDocuments(filter)
  ]);

  res.json({
    success: true,
    data: items,
    pagination: {
      page: p,
      limit: l,
      total,
      pages: Math.ceil(total / l)
    }
  });
});

// GET user's own skills (for dashboard)
exports.getMySkills = asyncHandler(async (req, res) => {
  const { userId } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { status = 'all', page = 1, limit = 10 } = req.query;
  const filter = { ownerId: String(userId) };

  if (status !== 'all') {
    filter.status = status;
  }

  const l = parseInt(limit);
  const p = parseInt(page);

  const [items, total] = await Promise.all([
    Skill.find(filter).sort({ createdAt: -1 }).limit(l).skip((p - 1) * l),
    Skill.countDocuments(filter)
  ]);

  res.json({
    success: true,
    data: items,
    pagination: {
      page: p,
      limit: l,
      total,
      pages: Math.ceil(total / l)
    }
  });
});

// GET single skill
exports.getSkillById = async (req, res) => {
  try {
    const { id } = req.params;
    const skill = await Skill.findById(id);

    if (!skill) {
      return res.status(404).json({
        success: false,
        message: 'Skill not found'
      });
    }

    res.status(200).json({
      success: true,
      data: skill
    });

  } catch (error) {
    console.error('Error fetching skill:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch skill',
      error: error.message
    });
  }
};

// GET skill for editing (only owner can access)
exports.getSkillForEdit = asyncHandler(async (req, res) => {
  const { userId } = getAuth(req);
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const skill = await Skill.findById(req.params.id);
  if (!skill) {
    res.status(404);
    throw new Error('Skill not found');
  }

  if (String(skill.ownerId) !== String(userId)) {
    return res.status(403).json({ success: false, message: 'You can only edit your own skills' });
  }

  res.json({ success: true, data: skill });
});

// CREATE skill with Python verification
exports.createSkill = asyncHandler(async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const email = await getUserEmail(userId);

    // Parse incoming form data
    let body;
    try {
      body = req.body.skillData ? JSON.parse(req.body.skillData) : req.body;
    } catch (err) {
      return res.status(400).json({ success: false, message: "Invalid skillData format" });
    }

    // Validate required fields
    const required = [
      "title",
      "instructor",
      "category",
      "level",
      "duration",
      "timePerWeek",
      "paymentOptions",
      "description",
      "credentialId"
    ];

    const missing = required.filter((f) => !body[f]);
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(", ")}`
      });
    }

    // Ensure certificate file uploaded
    if (!req.files?.certificate) {
      return res.status(400).json({
        success: false,
        message: "Certificate file is required"
      });
    }

    const certificateFile = req.files.certificate[0];
    const certificatePath = path.join(__dirname, "..", certificateFile.path);

    console.log("🐍 Using Python verification service...");

    const result = await verifyWithPython(certificatePath);

    if (!result || result.status !== 1) {
      const fsPromises = fs.promises;
      await fsPromises.unlink(certificatePath).catch(() => { });

      if (req.files?.introVideo) {
        const videoPath = path.join(__dirname, "..", req.files.introVideo[0].path);
        await fsPromises.unlink(videoPath).catch(() => { });
      }

      return res.status(400).json({
        success: false,
        message: result?.error || "Certificate verification failed",
        verificationFailed: true
      });
    }

    console.log("✅ Certificate verified via Python service");

    //CLOUDINARY UPLOAD(CLOUD STORAGE)
    console.log("☁️ Uploading certificate to cloud...");
    const certificateUrl = await uploadToCloud(certificatePath, 'certificates', 'image');

    // 2. Upload Intro Video (if exists)
    let introVideoUrl = "";
    if (req.files?.introVideo && req.files.introVideo[0]) {
      console.log("☁️ Uploading video to cloud...");
      const videoPath = path.join(__dirname, "..", req.files.introVideo[0].path);
      introVideoUrl = await uploadToCloud(videoPath, 'videos', 'video');
    }

    // Create Skill entry
    const newSkill = await Skill.create({
      ...body,
      ownerId: String(userId),
      email: email || "",
      certificateUrl, 
      introVideoUrl,  
      status: body.status || "published"
    });

    res.status(201).json({
      success: true,
      message: "✅ Skill created successfully with verified credentials",
      data: newSkill
    });
  } catch (error) {
    console.error("❌ Error creating skill:", error);

    // Clean up uploaded files if something fails
    if (req.files) {
      try {
        if (req.files.certificate && fs.existsSync(req.files.certificate[0].path)) {
          fs.unlinkSync(req.files.certificate[0].path);
        }
        if (req.files.introVideo && fs.existsSync(req.files.introVideo[0].path)) {
          fs.unlinkSync(req.files.introVideo[0].path);
        }
      } catch (cleanupErr) {
        console.error("Error cleaning up files:", cleanupErr);
      }
    }

    res.status(500).json({
      success: false,
      message: "Failed to create skill",
      error: error.message
    });
  }
});

// UPDATE skill
exports.updateSkill = async (req, res) => {
  try {
    const { userId } = getAuth(req);
    const { id } = req.params;

    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const skill = await Skill.findById(id);
    if (!skill) return res.status(404).json({ success: false, message: 'Skill not found' });

    if (String(skill.ownerId) !== String(userId)) {
      return res.status(403).json({ success: false, message: 'Forbidden: You can only update your own skills' });
    }

    const { skillData } = req.body;
    const parsedData = typeof skillData === 'string' ? JSON.parse(skillData) : skillData;

    if (req.files && req.files['certificate'] && req.files['certificate'][0]) {
      const certificateFile = req.files['certificate'][0];
      const certificatePath = path.join(__dirname, "..", certificateFile.path);

      console.log("🐍 Verifying updated certificate via Python...");
      const result = await verifyWithPython(certificatePath);

      if (!result || result.status !== 1) {
        fs.unlinkSync(certificatePath);
        return res.status(400).json({
          success: false,
          message: result?.error || "Certificate verification failed",
          verificationFailed: true
        });
      }

      console.log("✅ Updated certificate verified");
      const certificateUrl = await uploadToCloud(certificatePath, 'certificates', 'image');
      parsedData.certificateUrl = certificateUrl;
    }

    Object.assign(skill, parsedData);
    await skill.save();

    return res.json({ success: true, message: "Skill updated successfully", data: skill });
  } catch (error) {
    console.error('Error updating skill:', error);
    res.status(500).json({ success: false, message: 'Failed to update skill', error: error.message });
  }
};

// DELETE skill
exports.deleteSkill = asyncHandler(async (req, res) => {
  const { userId } = getAuth(req);
  const skill = await Skill.findById(req.params.id);

  if (!skill) {
    res.status(404);
    throw new Error('Skill not found');
  }

  if (String(skill.ownerId) !== String(userId)) {
    return res.status(403).json({ success: false, message: 'You can only delete your own skills' });
  }

  const fsPromises = require('fs').promises;
  if (skill.certificateUrl) {
    const certPath = path.join(__dirname, '..', skill.certificateUrl);
    await fsPromises.unlink(certPath).catch(() => { });
  }
  if (skill.introVideoUrl) {
    const videoPath = path.join(__dirname, '..', skill.introVideoUrl);
    await fsPromises.unlink(videoPath).catch(() => { });
  }

  await skill.deleteOne();
  res.json({ success: true, message: 'Skill deleted successfully' });
});

// SAVE draft
exports.saveDraft = async (req, res) => {
  try {
    const { userId } = getAuth(req);
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { skillData } = req.body;
    const parsedData = typeof skillData === 'string' ? JSON.parse(skillData) : skillData;

    let certificateUrl = '';
    if (req.files && req.files['certificate'] && req.files['certificate'][0]) {
      certificateUrl = generateFileUrl(req, req.files['certificate'][0].path);
    }

    let introVideoUrl = '';
    if (req.files && req.files['introVideo'] && req.files['introVideo'][0]) {
      introVideoUrl = generateFileUrl(req, req.files['introVideo'][0].path);
    }

    const draftSkill = new Skill({
      ...parsedData,
      ownerId: userId,
      certificateUrl,
      introVideoUrl,
      status: 'draft'
    });

    await draftSkill.save();
    res.status(201).json({ success: true, message: 'Draft saved successfully', data: draftSkill });
  } catch (error) {
    console.error('Error saving draft:', error);
    if (req.files) {
      if (req.files['certificate']) fs.unlinkSync(req.files['certificate'][0].path);
      if (req.files['introVideo']) fs.unlinkSync(req.files['introVideo'][0].path);
    }
    res.status(500).json({ success: false, message: 'Failed to save draft', error: error.message });
  }
};

// PUBLISH skill
exports.publishSkill = asyncHandler(async (req, res) => {
  const { userId } = getAuth(req);
  const skill = await Skill.findById(req.params.id);

  if (!skill) {
    res.status(404);
    throw new Error('Skill not found');
  }

  if (String(skill.ownerId) !== String(userId)) {
    return res.status(403).json({ success: false, message: 'You can only publish your own skills' });
  }

  if (skill.status === 'draft' && skill.certificateUrl) {
    const certificatePath = path.join(__dirname, '..', skill.certificateUrl);

    if (fs.existsSync(certificatePath)) {
      console.log("🐍 Verifying certificate before publishing via Python...");
      const result = await verifyWithPython(certificatePath);

      if (!result || result.status !== 1) {
        return res.status(400).json({
          success: false,
          message: result?.error || "Cannot publish: certificate verification failed",
          verificationFailed: true
        });
      }
      console.log("✅ Certificate verified - proceeding with publication");
    }
  }

  skill.status = 'published';
  await skill.save();

  res.json({ success: true, message: 'Skill published successfully', data: skill });
});

// ADD rating
exports.addRating = asyncHandler(async (req, res) => {
  const { rating, comment = '' } = req.body;
  const rNum = parseInt(rating, 10);

  if (!rNum || rNum < 1 || rNum > 5) {
    return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
  }

  const { userId } = getAuth(req);

  if (!userId) {
    return res.status(401).json({ success: false, message: 'You must be signed in to rate a skill' });
  }

  const item = await Skill.findById(req.params.id);
  if (!item) {
    res.status(404);
    throw new Error('Skill not found');
  }

  if (String(item.ownerId) === String(userId)) {
    return res.status(403).json({
      success: false,
      message: 'You cannot rate your own skill'
    });
  }

  const existingRating = item.ratings.find(r => String(r.userId) === String(userId));

  if (existingRating) {
    return res.status(400).json({
      success: false,
      message: 'You have already rated this skill',
      alreadyRated: true
    });
  }

  item.ratings.push({
    rating: rNum,
    comment: comment.trim(),
    userId: String(userId),
    createdAt: new Date()
  });

  item.calculateAverageRating();
  await item.save();

  res.json({
    success: true,
    message: 'Rating submitted successfully',
    data: {
      _id: item._id,
      averageRating: item.averageRating,
      totalRatings: item.totalRatings,
      ratings: item.ratings.sort((a, b) => b.createdAt - a.createdAt)
    }
  });
});

// GET user's rating for a specific skill
exports.getUserRating = asyncHandler(async (req, res) => {
  const { userId } = getAuth(req);

  if (!userId) {
    return res.json({
      success: true,
      data: { hasRated: false, rating: null }
    });
  }

  const item = await Skill.findById(req.params.id).select('ratings ownerId');
  if (!item) {
    res.status(404);
    throw new Error('Skill not found');
  }

  const isOwner = String(item.ownerId) === String(userId);
  const userRating = item.ratings.find(r => String(r.userId) === String(userId));

  res.json({
    success: true,
    data: {
      hasRated: !!userRating,
      isOwner: isOwner,
      rating: userRating || null
    }
  });
});

// GET ratings
exports.getRatings = asyncHandler(async (req, res) => {
  const item = await Skill.findById(req.params.id).select('ratings averageRating totalRatings');
  if (!item) {
    res.status(404);
    throw new Error('Skill not found');
  }

  res.json({
    success: true,
    data: {
      ratings: item.ratings.sort((a, b) => b.createdAt - a.createdAt),
      averageRating: item.averageRating,
      totalRatings: item.totalRatings
    }
  });
});