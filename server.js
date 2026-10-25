const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const QRCode = require('qrcode');
const bodyParser = require('body-parser');
const path = require('path');
const Twilio = require('twilio'); 
const crypto = require('crypto');

const app = express();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const adminSecret = process.env.ADMIN_SECRET; 

// Database Connection
const mongoURI = process.env.MONGO_URI;

mongoose.connect(mongoURI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ MongoDB Error:", err));

// Returns distance (lower = more similar). < 0.5 usually means same person.
function getEuclideanDistance(face1, face2) {
    const f1 = Object.values(face1);
    const f2 = Object.values(face2);
    return Math.sqrt(f1.reduce((sum, val, i) => sum + Math.pow(val - f2[i], 2), 0));
}

// HAVERSINE FORMULA FOR GEO-FENCING
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const toRad = (value) => value * Math.PI / 180;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lon2 - lon1);
    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c; // Distance in meters
}
    
// --- MIDDLEWARE ---
app.set('view engine', 'ejs');
app.use(express.static('public')); 
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

app.use(session({
    secret: 'secret-key-super-secure', 
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } 
}));

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhone = process.env.TWILIO_PHONE_NUMBER;



let client;
if (accountSid && accountSid.startsWith('AC')) {
    try {
        client = new Twilio(accountSid, authToken);
        console.log("✅ Twilio Client Initialized");
    } catch (err) {
        console.error("⚠️ Twilio Initialization Failed:", err.message);
    }
}

// --- DATABASE MODELS ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, 
    role: { type: String, enum: ['client', 'user'], required: true },
    phone: { type: String, default: null },
    faceDescriptor: { type: Object, default: null }, 
    profilePhoto: { type: String, default: null },
    isVerified: { type: Boolean, default: false },
    boundDeviceId: { type: String, default: null }, // NEW: Hardware locking
    createdAt: { type: Date, default: Date.now },
    resetPasswordToken: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null }
});

const SessionSchema = new mongoose.Schema({
    title: String,
    createdBy: mongoose.Schema.Types.ObjectId,
    createdAt: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
    sendSMS: { type: Boolean, default: true },
    location: { lat: Number, lng: Number }, // NEW: Geo-fencing origin
    secretSalt: { type: String, required: true } // NEW: Cryptographic salt
});

const AttendanceSchema = new mongoose.Schema({
    sessionId: mongoose.Schema.Types.ObjectId,
    userId: mongoose.Schema.Types.ObjectId,
    username: String,
    deviceId: { type: String, required: true }, 
    scannedAt: { type: Date, default: Date.now },
    status: { type: String, default: 'Present' }
});

const User = mongoose.model('User', UserSchema);
const Session = mongoose.model('Session', SessionSchema);
const Attendance = mongoose.model('Attendance', AttendanceSchema);

// --- HELPER FUNCTIONS ---

const requireLogin = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
};

async function sendSMS(phone, name, status, sessionTitle) {
    if (!phone) {
        console.log(`[SMS SKIP] No phone number for ${name}`);
        return;
    }
    const messageBody = `Dear ${name}, attendance for '${sessionTitle}': ${status.toUpperCase()}.`;

    console.log("------------------------------------------------");
    console.log(`📲 SIMULATION: SMS TO ${name} (${phone})`);
    console.log(`💬 MESSAGE: "${messageBody}"`);
    console.log("------------------------------------------------");

    if (client) {
        try {
            await client.messages.create({ body: messageBody, from: twilioPhone, to: phone });
            console.log(`✅ Twilio SMS Sent to ${name}`);
        } catch (error) {
            console.error("❌ Twilio Error:", error.message);
        }
    }
}

// --- ROUTES ---

app.get('/', (req, res) => res.render('home'));
app.get('/login', (req, res) => res.render('login', { error: req.query.error, success: req.query.success }));
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.get('/register', (req, res) => res.render('register', { error: null }));

app.post('/register', async (req, res) => {
    const { username, password, role, faceDescriptor, profilePhoto, phone, adminSecret } = req.body;
    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) return res.render('register', { error: 'Username already taken' });

        if (role === 'client') {
            if (adminSecret !== ADMIN_SECRET) {
                return res.render('register', { error: 'Invalid Teacher Access Key' });
            }
        }

        let faceData = null;
        if (faceDescriptor) {
            try { faceData = JSON.parse(faceDescriptor); } catch (e) { console.log("Error parsing face descriptor"); }
        }

        const isVerified = (role === 'client'); 

        const newUser = new User({
            username, password, role, phone,
            faceDescriptor: faceData, profilePhoto, isVerified
        });

        await newUser.save();
        res.redirect('/login');
    } catch (e) {
        console.error(e);
        res.render('register', { error: 'Error creating account. Try again.' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password, role } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user || user.password !== password || user.role !== role) {
            return res.render('login', { error: 'Invalid credentials', success: null });
        }
        req.session.userId = user._id;
        req.session.role = user.role;
        req.session.username = user.username;

        if (user.role === 'client') {
            return res.redirect('/client/dashboard');
        } else {
            if (!user.isVerified) {
                req.session.destroy();
                return res.redirect('/login?error=Account Pending Verification by Teacher');
            }
            return res.redirect('/user/dashboard');
        }
    } catch (e) {
        console.error(e);
        res.render('login', { error: 'Login error occurred', success: null });
    }
});

app.get('/forgot-password', (req, res) => {
    res.render('forgot-password', { error: null, success: null });
});

app.post('/forgot-password', async (req, res) => {
    const { username } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user) return res.render('forgot-password', { error: 'Username not found', success: null });
        if (!user.phone) return res.render('forgot-password', { error: 'No phone number linked. Contact Admin.', success: null });

        const token = crypto.randomBytes(20).toString('hex');
        user.resetPasswordToken = token;
        user.resetPasswordExpires = Date.now() + 3600000;
        await user.save();

        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host;
        const link = `${protocol}://${host}/reset-password/${token}`;
        const msg = `RESET PASSWORD: Click here to reset: ${link}`;

        if (client) {
            try {
                await client.messages.create({ body: msg, from: twilioPhone, to: user.phone });
            } catch (err) {
                return res.render('forgot-password', { error: 'Failed to send SMS.', success: null });
            }
        } else {
            console.log(`[SIMULATION] Reset Link: ${link}`);
        }
        res.render('forgot-password', { error: null, success: 'Reset link sent to your registered phone number.' });
    } catch (e) {
        console.error(e);
        res.render('forgot-password', { error: 'Server Error', success: null });
    }
});

app.get('/reset-password/:token', async (req, res) => {
    try {
        const user = await User.findOne({ 
            resetPasswordToken: req.params.token, 
            resetPasswordExpires: { $gt: Date.now() } 
        });
        if (!user) return res.render('forgot-password', { error: 'Token invalid or expired.', success: null });
        res.render('reset-password', { token: req.params.token, error: null });
    } catch (e) { res.redirect('/forgot-password'); }
});

app.post('/reset-password/:token', async (req, res) => {
    try {
        const user = await User.findOne({ 
            resetPasswordToken: req.params.token, 
            resetPasswordExpires: { $gt: Date.now() } 
        });
        if (!user) return res.render('forgot-password', { error: 'Token expired.', success: null });
        if (req.body.password !== req.body.confirm) return res.render('reset-password', { token: req.params.token, error: 'Passwords do not match' });

        user.password = req.body.password;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        await user.save();
        res.redirect('/login?success=Password reset successful.');
    } catch (e) { res.redirect('/forgot-password'); }
});

app.get('/profile', requireLogin, async (req, res) => {
    try {
        const user = await User.findById(req.session.userId);
        let pendingCount = 0;
        if (user.role === 'client') {
            pendingCount = await User.countDocuments({ role: 'user', isVerified: false });
        }
        res.render('profile', { 
            user, 
            success: req.query.success, 
            error: req.query.error,
            username: user.username,
            role: user.role,
            pendingCount
        });
    } catch (e) { 
        console.error(e);
        res.redirect('/'); 
    }
});

app.post('/profile/update', requireLogin, async (req, res) => {
    try {
        const { username, password, phone, profilePhoto, faceDescriptor } = req.body;
        const updates = { username, password, phone };
        let needsReverification = false;

        if (req.session.role === 'user' && profilePhoto && faceDescriptor) {
            updates.profilePhoto = profilePhoto;
            updates.faceDescriptor = JSON.parse(faceDescriptor);
            updates.isVerified = false;
            needsReverification = true;
        }

        await User.findByIdAndUpdate(req.session.userId, updates);
        if (needsReverification) {
            req.session.destroy();
            return res.redirect('/login?error=Profile updated. Wait for Re-verification.');
        }
        res.redirect('/profile?success=Updated Successfully');
    } catch (e) { res.redirect('/profile?error=Update Failed'); }
});

app.get('/client/dashboard', requireLogin, async (req, res) => {
    if (req.session.role !== 'client') return res.redirect('/login');

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    await Session.updateMany(
        { createdBy: req.session.userId, isActive: true, createdAt: { $lt: startOfToday } },
        { $set: { isActive: false } }
    );

    const sessions = await Session.find({ createdBy: req.session.userId }).sort({ createdAt: -1 });
    const pendingCount = await User.countDocuments({ role: 'user', isVerified: false });
    res.render('client-dashboard', { sessions, username: req.session.username, pendingCount });
});

app.post('/client/session/:id/toggle-sms', requireLogin, async (req, res) => {
    try {
        const session = await Session.findById(req.params.id);
        if (!session) return res.json({ success: false, message: "Session not found" });

        session.sendSMS = !session.sendSMS; 
        await session.save();
        
        console.log(`SMS Toggle for ${session.title}: ${session.sendSMS}`);
        res.json({ success: true, sendSMS: session.sendSMS });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false });
    }
});

app.get('/client/manage-students', requireLogin, async (req, res) => {
    if (req.session.role !== 'client') return res.redirect('/login');
    const pendingCount = await User.countDocuments({ role: 'user', isVerified: false });
    const students = await User.find({ role: 'user' }).sort({ isVerified: 1, username: 1 });
    res.render('manage-students', { 
        students, 
        error: req.query.error, 
        success: req.query.success,
        username: req.session.username,
        pendingCount
    });
});

app.get('/client/student/:id', requireLogin, async (req, res) => {
    if (req.session.role !== 'client') return res.redirect('/login');
    try {
        const student = await User.findById(req.params.id);
        if (!student) return res.redirect('/client/manage-students');

        const allSessions = await Session.find({}); 
        const attendanceRecords = await Attendance.find({ userId: student._id });
        const totalClasses = allSessions.length;
        const attendedClasses = attendanceRecords.length;
        const overallPercentage = totalClasses === 0 ? 0 : Math.round((attendedClasses / totalClasses) * 100);
        
        const subjectStats = {};
        allSessions.forEach(s => {
            if (!subjectStats[s.title]) subjectStats[s.title] = { name: s.title, total: 0, attended: 0, percentage: 0 };
            subjectStats[s.title].total++;
        });
        attendanceRecords.forEach(a => {
            const session = allSessions.find(s => s._id.equals(a.sessionId));
            if (session && subjectStats[session.title]) subjectStats[session.title].attended++;
        });
        const subjects = Object.values(subjectStats).map(sub => {
            sub.percentage = sub.total === 0 ? 0 : Math.round((sub.attended / sub.total) * 100);
            return sub;
        });

        const pendingCount = await User.countDocuments({ role: 'user', isVerified: false });

        res.render('student-profile', { 
            student, overallPercentage, attendedClasses, totalClasses, subjects,
            username: req.session.username,
            pendingCount
        });
    } catch (e) { res.redirect('/client/manage-students'); }
});

app.post('/client/add-student', requireLogin, async (req, res) => {
    try {
        const { username, password, profilePhoto, faceDescriptor, phone } = req.body;

        const existingUser = await User.findOne({ username });
        if (existingUser) return res.redirect('/client/manage-students?error=Username/ID Already Exists');

        const existingPhone = await User.findOne({ phone });
        if (existingPhone) return res.redirect('/client/manage-students?error=Phone Number Already Registered');

        let faceData = null;
        if (faceDescriptor) {
            try {
                faceData = JSON.parse(faceDescriptor);
                const usersWithFaces = await User.find({ faceDescriptor: { $ne: null } });
                for (const user of usersWithFaces) {
                    const distance = getEuclideanDistance(faceData, user.faceDescriptor);
                    if (distance < 0.5) { 
                        return res.redirect(`/client/manage-students?error=Face Match Detected: Already registered as ${user.username}`);
                    }
                }
            } catch (e) {
                console.error("Face Parse Error:", e);
            }
        }

        const newUser = new User({
            username, password, role: 'user', phone, 
            isVerified: true, profilePhoto: profilePhoto || null, faceDescriptor: faceData 
        });

        await newUser.save();
        res.redirect('/client/manage-students?success=Student Added Successfully');
    } catch (e) {
        console.error(e);
        res.redirect('/client/manage-students?error=Server Error');
    }
});

app.post('/client/delete-student/:id', requireLogin, async (req, res) => {
    try {
        await User.findByIdAndDelete(req.params.id);
        await Attendance.deleteMany({ userId: req.params.id });
        res.redirect('/client/manage-students?success=Deleted');
    } catch (e) { res.redirect('/client/manage-students?error=Failed'); }
});

app.get('/client/verify-students', requireLogin, async (req, res) => {
    if (req.session.role !== 'client') return res.redirect('/login');
    const pendingUsers = await User.find({ role: 'user', isVerified: false });
    const pendingCount = await User.countDocuments({ role: 'user', isVerified: false });
    res.render('verify-students', { pendingUsers, username: req.session.username, pendingCount });
});

app.post('/client/verify/:id', requireLogin, async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { isVerified: true });
    res.redirect('/client/verify-students');
});

app.post('/client/reject/:id', requireLogin, async (req, res) => {
    await User.findByIdAndDelete(req.params.id);
    res.redirect('/client/verify-students');
});

app.post('/client/create-session', requireLogin, async (req, res) => {
    try {
        const secretSalt = crypto.randomBytes(16).toString('hex'); // Generate dynamic salt
        await new Session({ 
            title: req.body.title, 
            createdBy: req.session.userId,
            location: { lat: parseFloat(req.body.lat), lng: parseFloat(req.body.lng) }, // Save Geo-location
            secretSalt: secretSalt 
        }).save();
        res.redirect('/client/dashboard');
    } catch (e) { res.redirect('/client/dashboard'); }
});

app.post('/client/session/:id/stop', requireLogin, async (req, res) => {
    try {
        const session = await Session.findById(req.params.id);
        session.isActive = false;
        await session.save();

        const allStudents = await User.find({ role: 'user' });
        const attendance = await Attendance.find({ sessionId: session._id });
        const presentIds = attendance.map(a => a.userId.toString());

        allStudents.forEach(student => {
            if (!presentIds.includes(student._id.toString()) && session.sendSMS) {
                sendSMS(student.phone, student.username, "ABSENT", session.title);
            }
        });
        res.redirect(`/client/session/${session._id}`);
    } catch (e) { res.redirect('/client/dashboard'); }
});

app.post('/client/session/:id/start', requireLogin, async (req, res) => {
    const session = await Session.findById(req.params.id);
    if (new Date(session.createdAt).toDateString() === new Date().toDateString()) {
        await Session.findByIdAndUpdate(req.params.id, { isActive: true });
    }
    res.redirect('/client/dashboard');
});

app.post('/client/session/:id/delete', requireLogin, async (req, res) => {
    await Session.findByIdAndDelete(req.params.id);
    await Attendance.deleteMany({ sessionId: req.params.id });
    res.redirect('/client/dashboard');
});

app.get('/client/session/:id', requireLogin, async (req, res) => {
    try {
        const sessionData = await Session.findById(req.params.id);
        const attendees = await Attendance.find({ sessionId: req.params.id });
        res.render('session-details', { sessionData, attendees });
    } catch (e) { res.redirect('/client/dashboard'); }
});

app.get('/client/session/:id/download', requireLogin, async (req, res) => {
    try {
        const session = await Session.findById(req.params.id);
        const attendees = await Attendance.find({ sessionId: req.params.id });
        let content = "Username\tDate\tTime\tDevice ID\n";
        attendees.forEach(a => {
            content += `${a.username}\t${a.scannedAt.toLocaleDateString()}\t${a.scannedAt.toLocaleTimeString()}\t${a.deviceId}\n`;
        });
        const filename = `${session.title.replace(/ /g, '_')}_${new Date().toISOString().split('T')[0]}.xls`;
        res.setHeader('Content-Type', 'application/vnd.ms-excel');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(content);
    } catch (e) { res.redirect('back'); }
});

app.get('/user/dashboard', requireLogin, async (req, res) => {
    if (req.session.role !== 'user') return res.redirect('/login');
    const user = await User.findById(req.session.userId);
    if (!user.isVerified) { req.session.destroy(); return res.redirect('/login?error=Not Verified'); }
    res.render('user-dashboard', { username: req.session.username, faceDescriptor: JSON.stringify(user.faceDescriptor || null) });
});

app.get('/user/history', requireLogin, async (req, res) => {
    try {
        const allSessions = await Session.find({});
        const myAttendance = await Attendance.find({ userId: req.session.userId });
        const subjectStats = {};
        allSessions.forEach(s => {
            const name = s.title.toUpperCase();
            if (!subjectStats[name]) subjectStats[name] = { name: s.title, totalClasses: 0, attended: 0, percentage: 0 };
            subjectStats[name].totalClasses++;
        });
        myAttendance.forEach(a => {
            const s = allSessions.find(x => x._id.equals(a.sessionId));
            if (s) subjectStats[s.title.toUpperCase()].attended++;
        });
        const stats = Object.values(subjectStats).map(s => {
            s.percentage = s.totalClasses ? Math.round((s.attended / s.totalClasses) * 100) : 0;
            return s;
        });
        const historyList = myAttendance.map(a => {
            const s = allSessions.find(x => x._id.equals(a.sessionId));
            return { title: s ? s.title : 'Unknown Session', date: a.scannedAt };
        }).sort((a, b) => b.date - a.date);
        res.render('user-history', { history: historyList, username: req.session.username, subjectStats: stats });
    } catch (e) { res.redirect('/user/dashboard'); }
});

// --- ENHANCED SECURITY ATTENDANCE MARKING ---
app.get('/mark-attendance/:sessionId', requireLogin, async (req, res) => {
    const { deviceId, lat, lng, t, hash } = req.query;
    
    if (!deviceId || !lat || !lng || !t || !hash) {
        return res.json({ success: false, message: "Missing required security parameters. Please rescan." });
    }

    try {
        const session = await Session.findById(req.params.sessionId);
        if (!session || !session.isActive) return res.json({ success: false, message: "Session Closed" });
        if (new Date(session.createdAt).toDateString() !== new Date().toDateString()) return res.json({ success: false, message: "Expired" });

        // 1. Dynamic QR Validation (15-second window)
        const timeDiff = Date.now() - parseInt(t);
        if (timeDiff > 15000 || timeDiff < 0) {
            return res.json({ success: false, message: "QR Code Expired. Please scan the latest code on the board." });
        }
        
        const expectedHash = crypto.createHash('sha256').update(`${session._id}-${t}-${session.secretSalt}`).digest('hex');
        if (hash !== expectedHash) {
            return res.json({ success: false, message: "Invalid cryptographic signature." });
        }

        // 2. Geo-Fencing Validation (20 meters)
        if (session.location && session.location.lat && session.location.lng) {
            const distance = calculateDistance(session.location.lat, session.location.lng, parseFloat(lat), parseFloat(lng));
            if (distance > 20) {
                return res.json({ success: false, message: `Geo-fencing failed! You are ${Math.round(distance)}m away from the classroom (Max: 20m).` });
            }
        }

        // 3. Hardware Device Binding
        const user = await User.findById(req.session.userId);
        if (!user.boundDeviceId) {
            user.boundDeviceId = deviceId; // Bind on first successful scan
            await user.save();
        } else if (user.boundDeviceId !== deviceId) {
            return res.json({ success: false, message: "Device mismatch! You cannot mark attendance from a different device." });
        }

        // Check if already marked
        const existingAttendance = await Attendance.findOne({ sessionId: session._id, userId: req.session.userId });
        if (existingAttendance) return res.json({ success: false, status: 'info', message: "Already Marked" });

        // Save Attendance
        await new Attendance({ sessionId: session._id, userId: req.session.userId, username: req.session.username, deviceId }).save();

        if (session.sendSMS) {
            sendSMS(user.phone, user.username, "PRESENT", session.title);
        }

        res.json({ success: true, message: "Attendance Marked Successfully" });
    } catch (e) { 
        console.error(e); 
        res.json({ success: false, message: "Error" }); 
    }
});

app.post('/client/manual-attendance', requireLogin, async (req, res) => {
    try {
        const { sessionId, username } = req.body;

        const student = await User.findOne({ username: username, role: 'user' });
        if (!student) return res.json({ success: false, message: "Student not found" });

        const session = await Session.findById(sessionId);
        if (!session) return res.json({ success: false, message: "Session not found" });

        const existing = await Attendance.findOne({ sessionId: session._id, userId: student._id });
        if (existing) return res.json({ success: false, message: "Attendance Already Marked" });

        await new Attendance({
            sessionId: session._id,
            userId: student._id,
            username: student.username,
            deviceId: "MANUAL_ENTRY_BY_TEACHER", 
            status: "Present"
        }).save();

        if (session.sendSMS) {
            sendSMS(student.phone, student.username, "PRESENT (MANUAL)", session.title);
        }

        res.json({ success: true, message: "Attendance marked successfully" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

app.get('/client/get-all-students', requireLogin, async (req, res) => {
    try {
        const students = await User.find({ role: 'user' }).select('username -_id');
        res.json(students);
    } catch (e) {
        res.json([]);
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));