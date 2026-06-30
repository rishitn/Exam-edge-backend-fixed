// =============================================================================
// ExamEdge — Database Seed
// Run: npx prisma db seed
// Seeds: Super Admin, Exam Taxonomy (Subjects/Chapters), Platform Settings
// =============================================================================

import { PrismaClient, ExamType, AdminRole, AdminStatus } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Starting ExamEdge database seed...\n");

  // ============================================================
  // 1. SUPER ADMIN
  // ============================================================
  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || "superadmin@examedge.in";
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || "ChangeMe@123";

  const existing = await prisma.admin.findUnique({ where: { email: superAdminEmail } });

  if (!existing) {
    const hash = await bcrypt.hash(superAdminPassword, 12);
    await prisma.admin.create({
      data: {
        name: "Super Admin",
        email: superAdminEmail,
        passwordHash: hash,
        role: AdminRole.SUPER_ADMIN,
        status: AdminStatus.ACTIVE,
        assignedExams: [ExamType.NEET, ExamType.JEE_MAIN, ExamType.JEE_ADVANCED, ExamType.CUET],
        totpEnabled: false, // Admin must enable on first login
      },
    });
    console.log(`✅ Super Admin created: ${superAdminEmail}`);
  } else {
    console.log(`⏭️  Super Admin already exists, skipping.`);
  }

  // ============================================================
  // 2. NEET SUBJECTS & CHAPTERS
  // ============================================================
  const neetTaxonomy = [
    {
      name: "Physics",
      code: "PHY",
      exam: ExamType.NEET,
      chapters: [
        "Physical World and Measurement",
        "Kinematics",
        "Laws of Motion",
        "Work, Energy and Power",
        "Motion of System of Particles and Rigid Body",
        "Gravitation",
        "Properties of Bulk Matter",
        "Thermodynamics",
        "Behaviour of Perfect Gas and Kinetic Theory",
        "Oscillations and Waves",
        "Electrostatics",
        "Current Electricity",
        "Magnetic Effects of Current and Magnetism",
        "Electromagnetic Induction and Alternating Currents",
        "Electromagnetic Waves",
        "Optics",
        "Dual Nature of Matter and Radiation",
        "Atoms and Nuclei",
        "Electronic Devices",
      ],
    },
    {
      name: "Chemistry",
      code: "CHEM",
      exam: ExamType.NEET,
      chapters: [
        "Some Basic Concepts of Chemistry",
        "Structure of Atom",
        "Classification of Elements and Periodicity in Properties",
        "Chemical Bonding and Molecular Structure",
        "States of Matter",
        "Thermodynamics",
        "Equilibrium",
        "Redox Reactions",
        "Hydrogen",
        "The S-Block Elements",
        "The P-Block Elements",
        "Organic Chemistry — Basic Principles and Techniques",
        "Hydrocarbons",
        "Environmental Chemistry",
        "Solid State",
        "Solutions",
        "Electrochemistry",
        "Chemical Kinetics",
        "Surface Chemistry",
        "General Principles and Processes of Isolation of Elements",
        "The D and F Block Elements",
        "Coordination Compounds",
        "Haloalkanes and Haloarenes",
        "Alcohols, Phenols and Ethers",
        "Aldehydes, Ketones and Carboxylic Acids",
        "Amines",
        "Biomolecules",
        "Polymers",
        "Chemistry in Everyday Life",
      ],
    },
    {
      name: "Biology",
      code: "BIO",
      exam: ExamType.NEET,
      chapters: [
        "The Living World",
        "Biological Classification",
        "Plant Kingdom",
        "Animal Kingdom",
        "Morphology of Flowering Plants",
        "Anatomy of Flowering Plants",
        "Structural Organisation in Animals",
        "Cell: The Unit of Life",
        "Biomolecules",
        "Cell Cycle and Cell Division",
        "Transport in Plants",
        "Mineral Nutrition",
        "Photosynthesis in Higher Plants",
        "Respiration in Plants",
        "Plant Growth and Development",
        "Digestion and Absorption",
        "Breathing and Exchange of Gases",
        "Body Fluids and Circulation",
        "Excretory Products and their Elimination",
        "Locomotion and Movement",
        "Neural Control and Coordination",
        "Chemical Coordination and Integration",
        "Reproduction in Organisms",
        "Sexual Reproduction in Flowering Plants",
        "Human Reproduction",
        "Reproductive Health",
        "Principles of Inheritance and Variation",
        "Molecular Basis of Inheritance",
        "Evolution",
        "Human Health and Disease",
        "Strategies for Enhancement in Food Production",
        "Microbes in Human Welfare",
        "Biotechnology: Principles and Processes",
        "Biotechnology and its Applications",
        "Organisms and Populations",
        "Ecosystem",
        "Biodiversity and Conservation",
        "Environmental Issues",
      ],
    },
  ];

  // ============================================================
  // 3. JEE MAIN SUBJECTS & CHAPTERS
  // ============================================================
  const jeeMainTaxonomy = [
    {
      name: "Physics",
      code: "PHY",
      exam: ExamType.JEE_MAIN,
      chapters: [
        "Units and Measurements",
        "Motion in a Straight Line",
        "Motion in a Plane",
        "Laws of Motion",
        "Work, Energy and Power",
        "System of Particles and Rotational Motion",
        "Gravitation",
        "Mechanical Properties of Solids",
        "Mechanical Properties of Fluids",
        "Thermal Properties of Matter",
        "Thermodynamics",
        "Kinetic Theory",
        "Oscillations",
        "Waves",
        "Electric Charges and Fields",
        "Electrostatic Potential and Capacitance",
        "Current Electricity",
        "Moving Charges and Magnetism",
        "Magnetism and Matter",
        "Electromagnetic Induction",
        "Alternating Current",
        "Electromagnetic Waves",
        "Ray Optics and Optical Instruments",
        "Wave Optics",
        "Dual Nature of Radiation and Matter",
        "Atoms",
        "Nuclei",
        "Semiconductor Electronics",
      ],
    },
    {
      name: "Chemistry",
      code: "CHEM",
      exam: ExamType.JEE_MAIN,
      chapters: [
        "Some Basic Concepts of Chemistry",
        "Structure of Atom",
        "Classification of Elements and Periodicity",
        "Chemical Bonding and Molecular Structure",
        "States of Matter",
        "Thermodynamics",
        "Equilibrium",
        "Redox Reactions",
        "Hydrogen",
        "S-Block Elements",
        "P-Block Elements (Group 13 & 14)",
        "Organic Chemistry — Basic Principles",
        "Hydrocarbons",
        "Environmental Chemistry",
        "Solid State",
        "Solutions",
        "Electrochemistry",
        "Chemical Kinetics",
        "Surface Chemistry",
        "D and F Block Elements",
        "Coordination Compounds",
        "Haloalkanes and Haloarenes",
        "Alcohols, Phenols and Ethers",
        "Aldehydes, Ketones and Carboxylic Acids",
        "Amines",
        "Biomolecules",
        "Polymers",
        "Chemistry in Everyday Life",
        "P-Block Elements (Group 15-18)",
      ],
    },
    {
      name: "Mathematics",
      code: "MATH",
      exam: ExamType.JEE_MAIN,
      chapters: [
        "Sets, Relations and Functions",
        "Complex Numbers and Quadratic Equations",
        "Matrices and Determinants",
        "Permutations and Combinations",
        "Mathematical Induction",
        "Binomial Theorem",
        "Sequences and Series",
        "Limit, Continuity and Differentiability",
        "Integral Calculus",
        "Differential Equations",
        "Coordinate Geometry",
        "Three Dimensional Geometry",
        "Vector Algebra",
        "Statistics and Probability",
        "Trigonometry",
        "Mathematical Reasoning",
      ],
    },
  ];

  // ============================================================
  // 4. CUET SUBJECTS
  // ============================================================
  const cuetTaxonomy = [
    {
      name: "English",
      code: "ENG",
      exam: ExamType.CUET,
      chapters: [
        "Reading Comprehension",
        "Verbal Ability",
        "Grammar and Usage",
        "Vocabulary",
      ],
    },
    {
      name: "General Test",
      code: "GT",
      exam: ExamType.CUET,
      chapters: [
        "General Knowledge and Current Affairs",
        "General Mental Ability",
        "Numerical Ability",
        "Quantitative Reasoning",
        "Logical and Analytical Reasoning",
      ],
    },
  ];

  // Seed all taxonomy
  const allTaxonomy = [...neetTaxonomy, ...jeeMainTaxonomy, ...cuetTaxonomy];

  for (const subjectData of allTaxonomy) {
    const subject = await prisma.subject.upsert({
      where: { exam_code: { exam: subjectData.exam, code: subjectData.code } },
      update: {},
      create: {
        name: subjectData.name,
        code: subjectData.code,
        exam: subjectData.exam,
        isActive: true,
      },
    });

    for (let i = 0; i < subjectData.chapters.length; i++) {
      await prisma.chapter.upsert({
        where: {
          // Use a computed unique field approach
          id: `${subject.id}_chapter_${i}`,
        },
        update: {},
        create: {
          id: `${subject.id}_chapter_${i}`,
          name: subjectData.chapters[i],
          subjectId: subject.id,
          order: i + 1,
          isActive: true,
        },
      });
    }

    console.log(`✅ Seeded ${subjectData.exam} — ${subjectData.name} (${subjectData.chapters.length} chapters)`);
  }

  // ============================================================
  // 5. SUBSCRIPTION PLANS
  // ============================================================
  const superAdmin = await prisma.admin.findUnique({ where: { email: superAdminEmail } });
  if (superAdmin) {
    const plans = [
      {
        name: "Pro Monthly",
        description: "Full access to all tests for 1 month",
        durationDays: 30,
        price: 299,
        originalPrice: 499,
        isPopular: false,
        features: ["Unlimited test attempts", "Detailed solutions", "All-India rank", "Chapter analytics"],
      },
      {
        name: "Pro Yearly",
        description: "Best value — full access for 1 year",
        durationDays: 365,
        price: 1999,
        originalPrice: 5988,
        isPopular: true,
        features: ["Unlimited test attempts", "Detailed solutions", "All-India rank", "Chapter analytics", "Priority support", "Previous Year Papers"],
      },
    ];

    for (const plan of plans) {
      await prisma.subscriptionPlan.upsert({
        where: { id: `seed_plan_${plan.durationDays}` },
        update: {},
        create: {
          id: `seed_plan_${plan.durationDays}`,
          ...plan,
          createdById: superAdmin.id,
        },
      });
    }
    console.log(`✅ Seeded ${plans.length} subscription plans`);
  }

  // ============================================================
  // 6. PLATFORM SETTINGS
  // ============================================================
  const settings = [
    { key: "maintenance_mode", value: false, description: "Put platform in maintenance mode" },
    { key: "max_tab_switches_allowed", value: 1, description: "Tabs switches before auto-submit" },
    { key: "otp_expiry_minutes", value: 10, description: "OTP validity window in minutes" },
    { key: "otp_max_attempts", value: 3, description: "Max wrong OTP attempts before lockout" },
    { key: "login_lockout_minutes", value: 15, description: "Account lockout duration after failed logins" },
    { key: "max_login_attempts", value: 5, description: "Failed logins before account lockout" },
    { key: "answer_autosave_interval_seconds", value: 30, description: "How often answers auto-save during test" },
    { key: "leaderboard_sync_interval_seconds", value: 60, description: "Redis → DB leaderboard sync frequency" },
    { key: "s3_bucket_name", value: "examedge-assets", description: "S3 bucket for all media uploads" },
    { key: "supported_image_types", value: ["image/jpeg", "image/png", "image/webp"], description: "Allowed upload MIME types" },
    { key: "max_upload_size_mb", value: 5, description: "Max image upload size in MB" },
  ];

  for (const setting of settings) {
    await prisma.platformSetting.upsert({
      where: { key: setting.key },
      update: {},
      create: {
        key: setting.key,
        value: setting.value,
        description: setting.description,
      },
    });
  }
  console.log(`✅ Seeded ${settings.length} platform settings`);

  console.log("\n🎉 Seed complete. ExamEdge is ready to build on.\n");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
