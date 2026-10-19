import { createHash } from 'node:crypto';

export const PROJECT_CREATOR_LEADER_MIGRATION = Object.freeze({
  migration: 'project-creator-leader-v1',
  requiredPermissions: Object.freeze([
    'project.read',
    'project.members.list',
    'project.members.add',
    'project.members.remove',
  ]),
});

function serializedId(value) {
  const id =
    typeof value === 'string'
      ? value
      : typeof value?.toHexString === 'function'
        ? value.toHexString()
        : null;
  return typeof id === 'string' && /^[\da-f]{24}$/i.test(id)
    ? id.toLowerCase()
    : null;
}

export function hashCreatorLeaderReport(report) {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

export function planProjectCreatorLeader({
  databaseName,
  targetFingerprint,
  targetProjectId,
  projects,
  memberships,
  roleAssignments,
  roles,
}) {
  const globalIssues = [];

  const teamLeaderRole = roles.find((r) => r.code === 'TEAM_LEADER');
  const roleCodesById = new Map(
    roles
      .map((role) => [serializedId(role._id), role.code])
      .filter(([id]) => id),
  );
  if (!teamLeaderRole) {
    globalIssues.push('ROLE_MISSING:TEAM_LEADER');
  } else {
    const permissions = Array.isArray(teamLeaderRole.permissions)
      ? teamLeaderRole.permissions
      : [];
    const missingPerms =
      PROJECT_CREATOR_LEADER_MIGRATION.requiredPermissions.filter(
        (p) => !permissions.includes(p),
      );
    if (missingPerms.length > 0) {
      globalIssues.push('ROLE_PERMISSIONS_INSUFFICIENT:TEAM_LEADER');
    }
  }

  const plannedPromotions = [];
  const alreadyCompliant = [];
  const skippedProjects = [];

  const hasTargetProjectId = targetProjectId !== undefined;
  const targetId = hasTargetProjectId ? serializedId(targetProjectId) : null;
  if (hasTargetProjectId && !targetId) {
    globalIssues.push('TARGET_PROJECT_ID_INVALID');
  }
  const filteredProjects = hasTargetProjectId
    ? targetId
      ? projects.filter((p) => serializedId(p._id) === targetId)
      : []
    : projects;

  if (targetId && filteredProjects.length === 0) {
    globalIssues.push(`TARGET_PROJECT_NOT_FOUND:${targetId}`);
  }

  for (const project of filteredProjects) {
    const projectId = serializedId(project._id);
    const creatorId = serializedId(project.createdBy);
    const orgId = serializedId(project.organizationId);

    if (!projectId || !creatorId || !orgId) {
      skippedProjects.push({
        projectId: projectId ?? 'invalid',
        projectName: project.name ?? 'unknown',
        reason: 'PROJECT_INVALID_ID',
      });
      continue;
    }

    // Check creator's active membership in project
    const creatorMemberships = memberships.filter(
      (m) =>
        serializedId(m.projectId) === projectId &&
        serializedId(m.userId) === creatorId &&
        m.status === 'ACTIVE',
    );
    const creatorMembership = creatorMemberships.find(
      (m) => serializedId(m.organizationId) === orgId,
    );

    if (!creatorMembership) {
      skippedProjects.push({
        projectId,
        projectName: project.name,
        creatorId,
        reason: creatorMemberships.length
          ? 'CREATOR_MEMBERSHIP_ORGANIZATION_MISMATCH'
          : 'CREATOR_MEMBERSHIP_MISSING',
      });
      continue;
    }

    // Role assignments on this project
    const assignmentsForProject = roleAssignments.filter(
      (ra) => serializedId(ra.projectId) === projectId,
    );
    if (
      assignmentsForProject.some(
        (ra) => serializedId(ra.organizationId) !== orgId,
      )
    ) {
      skippedProjects.push({
        projectId,
        projectName: project.name,
        creatorId,
        reason: 'PROJECT_ASSIGNMENT_ORGANIZATION_MISMATCH',
      });
      continue;
    }
    const projectAssignments = assignmentsForProject.filter(
      (ra) => serializedId(ra.organizationId) === orgId,
    );

    const creatorAssignments = projectAssignments.filter(
      (ra) => serializedId(ra.userId) === creatorId,
    );

    if (creatorAssignments.length === 0) {
      skippedProjects.push({
        projectId,
        projectName: project.name,
        creatorId,
        reason: 'CREATOR_ASSIGNMENT_MISSING',
      });
      continue;
    }

    if (creatorAssignments.length > 1) {
      skippedProjects.push({
        projectId,
        projectName: project.name,
        creatorId,
        reason: 'CONFLICTING_CREATOR_ASSIGNMENTS',
      });
      continue;
    }

    const creatorAssignment = creatorAssignments[0];
    const assignmentId = serializedId(creatorAssignment._id);
    const creatorRoleId = serializedId(creatorAssignment.roleId);
    const resolvedRoleCode = roleCodesById.get(creatorRoleId);

    if (
      !assignmentId ||
      !creatorRoleId ||
      !resolvedRoleCode ||
      resolvedRoleCode !== creatorAssignment.roleCode
    ) {
      skippedProjects.push({
        projectId,
        projectName: project.name,
        creatorId,
        reason: 'ROLE_CODE_ID_MISMATCH',
      });
      continue;
    }

    if (creatorAssignment.roleCode === 'TEAM_LEADER') {
      alreadyCompliant.push({
        projectId,
        projectName: project.name,
        creatorId,
      });
      continue;
    }

    if (creatorAssignment.roleCode === 'MEMBER') {
      const otherLeaders = projectAssignments.filter(
        (ra) =>
          ra.roleCode === 'TEAM_LEADER' &&
          serializedId(ra.userId) !== creatorId,
      );
      if (otherLeaders.length > 0) {
        skippedProjects.push({
          projectId,
          projectName: project.name,
          creatorId,
          reason: 'EXISTING_TEAM_LEADER_EXISTS',
        });
        continue;
      }

      if (teamLeaderRole && globalIssues.length === 0) {
        plannedPromotions.push({
          projectId,
          organizationId: orgId,
          projectName: project.name,
          creatorId,
          assignmentId,
          fromRoleId: creatorRoleId,
          fromRoleCode: 'MEMBER',
          toRoleCode: 'TEAM_LEADER',
          toRoleId: serializedId(teamLeaderRole._id),
        });
      }
      continue;
    }

    skippedProjects.push({
      projectId,
      projectName: project.name,
      creatorId,
      reason: `UNEXPECTED_CREATOR_ROLE:${creatorAssignment.roleCode}`,
    });
  }

  const isSafe = globalIssues.length === 0 && skippedProjects.length === 0;

  return {
    databaseName,
    targetFingerprint,
    targetProjectId: targetId,
    isSafe,
    globalIssues,
    plannedPromotions,
    alreadyCompliant,
    skippedProjects,
    summary: {
      totalProjectsInspected: filteredProjects.length,
      promotionsNeeded: plannedPromotions.length,
      alreadyCompliant: alreadyCompliant.length,
      skippedCount: skippedProjects.length,
      globalIssuesCount: globalIssues.length,
    },
  };
}
