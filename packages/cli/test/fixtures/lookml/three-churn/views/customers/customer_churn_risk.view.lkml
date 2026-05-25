view: customers {
  sql_table_name: customers ;;
  dimension: id {
    type: number
    primary_key: yes
    sql: ${TABLE}.id ;;
  }
  dimension: engagement_score {
    type: number
    sql: ${TABLE}.engagement_score ;;
  }
  measure: churn_risk_score {
    type: average
    sql: 1 - ${engagement_score} / 100.0 ;;
  }
}
